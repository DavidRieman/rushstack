// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as crypto from 'crypto';
import { Async, InternalError, NewlineKind, Sort } from '@rushstack/node-core-library';
import { CollatedTerminal, type CollatedWriter } from '@rushstack/stream-collator';
import { DiscardStdoutTransform, TextRewriterTransform } from '@rushstack/terminal';
import { SplitterTransform, type TerminalWritable, type ITerminal, Terminal } from '@rushstack/terminal';

import { CollatedTerminalProvider } from '../../utilities/CollatedTerminalProvider';
import { OperationStatus } from './OperationStatus';
import { CobuildLock, type ICobuildCompletedState } from '../cobuild/CobuildLock';
import { ProjectBuildCache } from '../buildCache/ProjectBuildCache';
import { RushConstants } from '../RushConstants';
import type { IOperationSettings, RushProjectConfiguration } from '../../api/RushProjectConfiguration';
import { getHashesForGlobsAsync } from '../buildCache/getHashesForGlobsAsync';
import { ProjectLogWritable } from './ProjectLogWritable';
import type { CobuildConfiguration } from '../../api/CobuildConfiguration';
import { DisjointSet } from '../cobuild/DisjointSet';
import { PeriodicCallback } from './PeriodicCallback';
import { NullTerminalProvider } from '../../utilities/NullTerminalProvider';

import type { Operation } from './Operation';
import type { IOperationRunnerContext } from './IOperationRunner';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import type {
  IExecuteOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import type { IPhase } from '../../api/CommandLineConfiguration';
import type { IRawRepoState, ProjectChangeAnalyzer } from '../ProjectChangeAnalyzer';
import type { OperationMetadataManager } from './OperationMetadataManager';
import type { BuildCacheConfiguration } from '../../api/BuildCacheConfiguration';
import type { IOperationExecutionResult } from './IOperationExecutionResult';
import type { OperationExecutionRecord } from './OperationExecutionRecord';

const PLUGIN_NAME: 'CacheablePhasedOperationPlugin' = 'CacheablePhasedOperationPlugin';
const PERIODIC_CALLBACK_INTERVAL_IN_SECONDS: number = 10;

export interface IProjectDeps {
  files: { [filePath: string]: string };
  arguments: string;
}

export interface IOperationBuildCacheContext {
  isCacheWriteAllowed: boolean;
  isCacheReadAllowed: boolean;

  projectChangeAnalyzer: ProjectChangeAnalyzer;
  projectBuildCache: ProjectBuildCache | undefined;
  cacheDisabledReason: string | undefined;
  operationSettings: IOperationSettings | undefined;

  cobuildLock: CobuildLock | undefined;

  // The id of the cluster contains the operation, used when acquiring cobuild lock
  cobuildClusterId: string | undefined;

  // Controls the log for the cache subsystem
  buildCacheTerminal: ITerminal | undefined;
  buildCacheProjectLogWritable: ProjectLogWritable | undefined;

  periodicCallback: PeriodicCallback;
  cacheRestored: boolean;
  isCacheReadAttempted: boolean;
}

export interface ICacheableOperationPluginOptions {
  allowWarningsInSuccessfulBuild: boolean;
  buildCacheConfiguration: BuildCacheConfiguration;
  cobuildConfiguration: CobuildConfiguration | undefined;
  terminal: ITerminal;
}

export class CacheableOperationPlugin implements IPhasedCommandPlugin {
  private _buildCacheContextByOperation: Map<Operation, IOperationBuildCacheContext> = new Map();

  private readonly _options: ICacheableOperationPluginOptions;

  public constructor(options: ICacheableOperationPluginOptions) {
    this._options = options;
  }

  public apply(hooks: PhasedCommandHooks): void {
    const { allowWarningsInSuccessfulBuild, buildCacheConfiguration, cobuildConfiguration, terminal } =
      this._options;

    hooks.beforeExecuteOperations.tapPromise(
      PLUGIN_NAME,
      async (
        recordByOperation: Map<Operation, IOperationExecutionResult>,
        context: IExecuteOperationsContext
      ): Promise<void> => {
        const { isIncrementalBuildAllowed, projectChangeAnalyzer, projectConfigurations, isInitial } =
          context;

        const disjointSet: DisjointSet<Operation> | undefined = cobuildConfiguration?.cobuildFeatureEnabled
          ? new DisjointSet()
          : undefined;

        await Async.forEachAsync(
          recordByOperation.keys(),
          async (operation: Operation) => {
            const { associatedProject, associatedPhase, runner } = operation;
            if (!associatedProject || !associatedPhase || !runner) {
              return;
            }

            const { name: phaseName } = associatedPhase;

            const projectConfiguration: RushProjectConfiguration | undefined =
              projectConfigurations.get(associatedProject);

            // This value can *currently* be cached per-project, but in the future the list of files will vary
            // depending on the selected phase.
            const fileHashes: Map<string, string> | undefined =
              await projectChangeAnalyzer._tryGetProjectDependenciesAsync(associatedProject, terminal);

            if (!fileHashes) {
              throw new Error(
                `Build cache is only supported if running in a Git repository. Either disable the build cache or run Rush in a Git repository.`
              );
            }

            const operationSettings: IOperationSettings | undefined =
              projectConfiguration?.operationSettingsByOperationName.get(phaseName);
            const cacheDisabledReason: string | undefined = projectConfiguration
              ? projectConfiguration.getCacheDisabledReason(operation, fileHashes.keys(), phaseName)
              : `Project does not have a ${RushConstants.rushProjectConfigFilename} configuration file, ` +
                'or one provided by a rig, so it does not support caching.';

            disjointSet?.add(operation);

            const buildCacheContext: IOperationBuildCacheContext = {
              // Supports cache writes by default for initial operations.
              // Don't write during watch runs for performance reasons (and to avoid flooding the cache)
              isCacheWriteAllowed: isInitial,
              isCacheReadAllowed: isIncrementalBuildAllowed,
              projectBuildCache: undefined,
              projectChangeAnalyzer,
              operationSettings,
              cacheDisabledReason,
              cobuildLock: undefined,
              cobuildClusterId: undefined,
              buildCacheTerminal: undefined,
              buildCacheProjectLogWritable: undefined,
              periodicCallback: new PeriodicCallback({
                interval: PERIODIC_CALLBACK_INTERVAL_IN_SECONDS * 1000
              }),
              cacheRestored: false,
              isCacheReadAttempted: false
            };
            // Upstream runners may mutate the property of build cache context for downstream runners
            this._buildCacheContextByOperation.set(operation, buildCacheContext);
          },
          {
            concurrency: 10
          }
        );

        if (disjointSet) {
          // If disjoint set exists, connect build cache disabled project with its consumers
          for (const [operation, { cacheDisabledReason }] of this._buildCacheContextByOperation) {
            const { associatedProject: project, associatedPhase: phase } = operation;
            if (project && phase) {
              if (cacheDisabledReason) {
                /**
                 * Group the project build cache disabled with its consumers. This won't affect too much in
                 * a monorepo with high build cache coverage.
                 *
                 * The mental model is that if X disables the cache, and Y depends on X, then:
                 *   1. Y must be built by the same VM that build X;
                 *   2. OR, Y must be rebuilt on each VM that needs it.
                 * Approach 1 is probably the better choice.
                 */
                for (const consumer of operation.consumers) {
                  disjointSet?.union(operation, consumer);
                }
              }
            }
          }

          logCobuildBuildPlan(disjointSet, terminal, this._buildCacheContextByOperation);

          for (const operationSet of disjointSet.getAllSets()) {
            if (cobuildConfiguration?.cobuildFeatureEnabled && cobuildConfiguration.cobuildContextId) {
              // Get a deterministic ordered array of operations, which is important to get a deterministic cluster id.
              const groupedOperations: Operation[] = Array.from(operationSet);
              Sort.sortBy(groupedOperations, (operation: Operation) => {
                return operation.name;
              });

              // Generates cluster id, cluster id comes from the project folder and phase name of all operations in the same cluster.
              const hash: crypto.Hash = crypto.createHash('sha1');
              for (const operation of groupedOperations) {
                const { associatedPhase: phase, associatedProject: project } = operation;
                if (project && phase) {
                  hash.update(project.projectRelativeFolder);
                  hash.update(RushConstants.hashDelimiter);
                  hash.update(phase.name);
                  hash.update(RushConstants.hashDelimiter);
                }
              }
              const cobuildClusterId: string = hash.digest('hex');

              // Assign same cluster id to all operations in the same cluster.
              for (const record of groupedOperations) {
                const buildCacheContext: IOperationBuildCacheContext =
                  this._getBuildCacheContextByOperationOrThrow(record);
                buildCacheContext.cobuildClusterId = cobuildClusterId;
              }
            }
          }
        }
      }
    );

    hooks.beforeExecuteOperation.tapPromise(
      PLUGIN_NAME,
      async (
        runnerContext: IOperationRunnerContext & IOperationExecutionResult
      ): Promise<OperationStatus | undefined> => {
        if (this._buildCacheContextByOperation.size === 0) {
          return;
        }

        const buildCacheContext: IOperationBuildCacheContext | undefined =
          this._getBuildCacheContextByOperation(runnerContext.operation);

        if (!buildCacheContext) {
          return;
        }

        const record: OperationExecutionRecord = runnerContext as OperationExecutionRecord;
        const {
          associatedProject: project,
          associatedPhase: phase,
          runner,
          _operationMetadataManager: operationMetadataManager
        } = record;

        if (!project || !phase || !runner?.cacheable) {
          return;
        }

        const runBeforeExecute = async (): Promise<OperationStatus | undefined> => {
          const buildCacheTerminal: ITerminal = this._getBuildCacheTerminal({
            record,
            buildCacheContext,
            buildCacheEnabled: buildCacheConfiguration?.buildCacheEnabled,
            rushProject: project,
            logFilenameIdentifier: phase.logFilenameIdentifier,
            quietMode: record.quietMode,
            debugMode: record.debugMode
          });
          buildCacheContext.buildCacheTerminal = buildCacheTerminal;

          const configHash: string = runner.getConfigHash() || '';

          let projectBuildCache: ProjectBuildCache | undefined = await this._tryGetProjectBuildCacheAsync({
            buildCacheContext,
            buildCacheConfiguration,
            rushProject: project,
            phase,
            configHash,
            terminal: buildCacheTerminal,
            operationMetadataManager
          });

          // Try to acquire the cobuild lock
          let cobuildLock: CobuildLock | undefined;
          if (cobuildConfiguration?.cobuildFeatureEnabled) {
            if (
              cobuildConfiguration?.cobuildLeafProjectLogOnlyAllowed &&
              record.operation.consumers.size === 0 &&
              !projectBuildCache
            ) {
              // When the leaf project log only is allowed and the leaf project is build cache "disabled", try to get
              // a log files only project build cache
              projectBuildCache = await this._tryGetLogOnlyProjectBuildCacheAsync({
                buildCacheConfiguration,
                cobuildConfiguration,
                buildCacheContext,
                rushProject: project,
                phase,
                configHash,
                terminal: buildCacheTerminal,
                operationMetadataManager
              });
              if (projectBuildCache) {
                buildCacheTerminal.writeVerboseLine(
                  `Log files only build cache is enabled for the project "${project.packageName}" because the cobuild leaf project log only is allowed`
                );
              } else {
                buildCacheTerminal.writeWarningLine(
                  `Failed to get log files only build cache for the project "${project.packageName}"`
                );
              }
            }

            cobuildLock = await this._tryGetCobuildLockAsync({
              buildCacheContext,
              projectBuildCache,
              cobuildConfiguration,
              packageName: project.packageName,
              phaseName: phase.name
            });
          }

          // eslint-disable-next-line require-atomic-updates -- we are mutating the build cache context intentionally
          buildCacheContext.cobuildLock = cobuildLock;

          // If possible, we want to skip this operation -- either by restoring it from the
          // cache, if caching is enabled, or determining that the project
          // is unchanged (using the older incremental execution logic). These two approaches,
          // "caching" and "skipping", are incompatible, so only one applies.
          //
          // Note that "caching" and "skipping" take two different approaches
          // to tracking dependents:
          //
          //   - For caching, "isCacheReadAllowed" is set if a project supports
          //     incremental builds, and determining whether this project or a dependent
          //     has changed happens inside the hashing logic.
          //

          const { logPath, errorLogPath } = ProjectLogWritable.getLogFilePaths({
            project,
            logFilenameIdentifier: phase.logFilenameIdentifier
          });
          const restoreCacheAsync = async (
            // TODO: Investigate if `projectBuildCacheForRestore` is always the same instance as `projectBuildCache`
            // above, and if it is, remove this parameter
            projectBuildCacheForRestore: ProjectBuildCache | undefined,
            specifiedCacheId?: string
          ): Promise<boolean> => {
            buildCacheContext.isCacheReadAttempted = true;
            const restoreFromCacheSuccess: boolean | undefined =
              await projectBuildCacheForRestore?.tryRestoreFromCacheAsync(
                buildCacheTerminal,
                specifiedCacheId
              );
            if (restoreFromCacheSuccess) {
              buildCacheContext.cacheRestored = true;
              // Restore the original state of the operation without cache
              await operationMetadataManager?.tryRestoreAsync({
                terminal: buildCacheTerminal,
                logPath,
                errorLogPath
              });
            }
            return !!restoreFromCacheSuccess;
          };
          if (cobuildLock) {
            // handling rebuilds. "rush rebuild" or "rush retest" command will save operations to
            // the build cache once completed, but does not retrieve them (since the "incremental"
            // flag is disabled). However, we still need a cobuild to be able to retrieve a finished
            // build from another cobuild in this case.
            const cobuildCompletedState: ICobuildCompletedState | undefined =
              await cobuildLock.getCompletedStateAsync();
            if (cobuildCompletedState) {
              const { status, cacheId } = cobuildCompletedState;

              const restoreFromCacheSuccess: boolean = await restoreCacheAsync(
                cobuildLock.projectBuildCache,
                cacheId
              );

              if (restoreFromCacheSuccess) {
                if (cobuildCompletedState) {
                  return cobuildCompletedState.status;
                }
                return status;
              }
            } else if (!buildCacheContext.isCacheReadAttempted && buildCacheContext.isCacheReadAllowed) {
              const restoreFromCacheSuccess: boolean = await restoreCacheAsync(projectBuildCache);

              if (restoreFromCacheSuccess) {
                return OperationStatus.FromCache;
              }
            }
          } else if (buildCacheContext.isCacheReadAllowed) {
            const restoreFromCacheSuccess: boolean = await restoreCacheAsync(projectBuildCache);

            if (restoreFromCacheSuccess) {
              return OperationStatus.FromCache;
            }
          }

          if (buildCacheContext.isCacheWriteAllowed && cobuildLock) {
            const acquireSuccess: boolean = await cobuildLock.tryAcquireLockAsync();
            if (acquireSuccess) {
              const { periodicCallback } = buildCacheContext;
              periodicCallback.addCallback(async () => {
                await cobuildLock?.renewLockAsync();
              });
              periodicCallback.start();
            } else {
              // failed to acquire the lock, mark current operation to remote executing
              return OperationStatus.RemoteExecuting;
            }
          }
        };

        try {
          const earlyReturnStatus: OperationStatus | undefined = await runBeforeExecute();
          return earlyReturnStatus;
        } catch (e) {
          buildCacheContext.buildCacheProjectLogWritable?.close();
          throw e;
        }
      }
    );

    hooks.afterExecuteOperation.tapPromise(
      PLUGIN_NAME,
      async (runnerContext: IOperationRunnerContext): Promise<void> => {
        const record: OperationExecutionRecord = runnerContext as OperationExecutionRecord;
        const { status, stopwatch, _operationMetadataManager: operationMetadataManager, operation } = record;

        const { associatedProject: project, associatedPhase: phase, runner } = operation;

        if (!project || !phase || !runner?.cacheable) {
          return;
        }

        const buildCacheContext: IOperationBuildCacheContext | undefined =
          this._getBuildCacheContextByOperation(operation);

        if (!buildCacheContext) {
          return;
        }

        // No need to run for the following operation status
        switch (record.status) {
          case OperationStatus.NoOp:
          case OperationStatus.RemoteExecuting: {
            return;
          }
          default: {
            break;
          }
        }

        const { cobuildLock, projectBuildCache, isCacheWriteAllowed, buildCacheTerminal, cacheRestored } =
          buildCacheContext;

        try {
          if (!cacheRestored) {
            // Save the metadata to disk
            const { logFilenameIdentifier } = phase;
            const { duration: durationInSeconds } = stopwatch;
            const { logPath, errorLogPath } = ProjectLogWritable.getLogFilePaths({
              project,
              logFilenameIdentifier
            });
            await operationMetadataManager?.saveAsync({
              durationInSeconds,
              cobuildContextId: cobuildLock?.cobuildConfiguration.cobuildContextId,
              cobuildRunnerId: cobuildLock?.cobuildConfiguration.cobuildRunnerId,
              logPath,
              errorLogPath
            });
          }

          if (!buildCacheTerminal) {
            // This should not happen
            throw new InternalError(`Build Cache Terminal is not created`);
          }

          let setCompletedStatePromiseFunction: (() => Promise<void> | undefined) | undefined;
          let setCacheEntryPromise: (() => Promise<boolean> | undefined) | undefined;
          if (cobuildLock && isCacheWriteAllowed) {
            const { cacheId, contextId } = cobuildLock.cobuildContext;

            let finalCacheId: string = cacheId;
            if (status === OperationStatus.Failure) {
              finalCacheId = `${cacheId}-${contextId}-failed`;
            } else if (status === OperationStatus.SuccessWithWarning && !record.runner.warningsAreAllowed) {
              finalCacheId = `${cacheId}-${contextId}-warnings`;
            }
            switch (status) {
              case OperationStatus.SuccessWithWarning:
              case OperationStatus.Success:
              case OperationStatus.Failure: {
                const currentStatus: ICobuildCompletedState['status'] = status;
                setCompletedStatePromiseFunction = () => {
                  return cobuildLock?.setCompletedStateAsync({
                    status: currentStatus,
                    cacheId: finalCacheId
                  });
                };
                setCacheEntryPromise = () =>
                  cobuildLock.projectBuildCache.trySetCacheEntryAsync(buildCacheTerminal, finalCacheId);
              }
            }
          }

          const taskIsSuccessful: boolean =
            status === OperationStatus.Success ||
            (status === OperationStatus.SuccessWithWarning &&
              record.runner.warningsAreAllowed &&
              allowWarningsInSuccessfulBuild);

          // If the command is successful, we can calculate project hash, and no dependencies were skipped,
          // write a new cache entry.
          if (!setCacheEntryPromise && taskIsSuccessful && isCacheWriteAllowed && projectBuildCache) {
            setCacheEntryPromise = () => projectBuildCache.trySetCacheEntryAsync(buildCacheTerminal);
          }
          if (!cacheRestored) {
            const cacheWriteSuccess: boolean | undefined = await setCacheEntryPromise?.();
            await setCompletedStatePromiseFunction?.();

            if (cacheWriteSuccess === false && status === OperationStatus.Success) {
              record.status = OperationStatus.SuccessWithWarning;
            }
          }
        } finally {
          buildCacheContext.buildCacheProjectLogWritable?.close();
          buildCacheContext.periodicCallback.stop();
        }
      }
    );

    hooks.afterExecuteOperation.tap(
      PLUGIN_NAME,
      (record: IOperationRunnerContext & IOperationExecutionResult): void => {
        const { operation } = record;
        const buildCacheContext: IOperationBuildCacheContext | undefined =
          this._buildCacheContextByOperation.get(operation);
        // Status changes to direct dependents
        let blockCacheWrite: boolean = !buildCacheContext?.isCacheWriteAllowed;

        switch (record.status) {
          case OperationStatus.Skipped: {
            // Skipping means cannot guarantee integrity, so prevent cache writes in dependents.
            blockCacheWrite = true;
            break;
          }
        }

        // Apply status changes to direct dependents
        if (blockCacheWrite) {
          for (const consumer of operation.consumers) {
            const consumerBuildCacheContext: IOperationBuildCacheContext | undefined =
              this._getBuildCacheContextByOperation(consumer);
            if (consumerBuildCacheContext) {
              consumerBuildCacheContext.isCacheWriteAllowed = false;
            }
          }
        }
      }
    );

    hooks.afterExecuteOperations.tapPromise(PLUGIN_NAME, async () => {
      this._buildCacheContextByOperation.clear();
    });
  }

  private _getBuildCacheContextByOperation(operation: Operation): IOperationBuildCacheContext | undefined {
    const buildCacheContext: IOperationBuildCacheContext | undefined =
      this._buildCacheContextByOperation.get(operation);
    return buildCacheContext;
  }

  private _getBuildCacheContextByOperationOrThrow(operation: Operation): IOperationBuildCacheContext {
    const buildCacheContext: IOperationBuildCacheContext | undefined =
      this._getBuildCacheContextByOperation(operation);
    if (!buildCacheContext) {
      // This should not happen
      throw new InternalError(`Build cache context for operation ${operation.name} should be defined`);
    }
    return buildCacheContext;
  }

  private async _tryGetProjectBuildCacheAsync({
    buildCacheConfiguration,
    buildCacheContext,
    rushProject,
    phase,
    configHash,
    terminal,
    operationMetadataManager
  }: {
    buildCacheContext: IOperationBuildCacheContext;
    buildCacheConfiguration: BuildCacheConfiguration | undefined;
    rushProject: RushConfigurationProject;
    phase: IPhase;
    configHash: string;
    terminal: ITerminal;
    operationMetadataManager: OperationMetadataManager | undefined;
  }): Promise<ProjectBuildCache | undefined> {
    if (!buildCacheContext.projectBuildCache) {
      const { cacheDisabledReason } = buildCacheContext;
      if (cacheDisabledReason) {
        terminal.writeVerboseLine(cacheDisabledReason);
        return;
      }

      const { operationSettings, projectChangeAnalyzer } = buildCacheContext;
      if (!operationSettings || !buildCacheConfiguration) {
        // Unreachable, since this will have set `cacheDisabledReason`.
        return;
      }

      const projectOutputFolderNames: ReadonlyArray<string> = operationSettings.outputFolderNames || [];
      const additionalProjectOutputFilePaths: ReadonlyArray<string> =
        operationMetadataManager?.relativeFilepaths || [];
      const additionalContext: Record<string, string> = {};

      await updateAdditionalContextAsync({
        operationSettings,
        additionalContext,
        projectChangeAnalyzer,
        terminal,
        rushProject
      });

      // eslint-disable-next-line require-atomic-updates -- This is guaranteed to not be concurrent
      buildCacheContext.projectBuildCache = await ProjectBuildCache.tryGetProjectBuildCache({
        project: rushProject,
        projectOutputFolderNames,
        additionalProjectOutputFilePaths,
        additionalContext,
        buildCacheConfiguration,
        terminal,
        configHash,
        projectChangeAnalyzer,
        phaseName: phase.name
      });
    }

    return buildCacheContext.projectBuildCache;
  }

  // Get a ProjectBuildCache only cache/restore log files
  private async _tryGetLogOnlyProjectBuildCacheAsync({
    buildCacheContext,
    rushProject,
    terminal,
    configHash,
    buildCacheConfiguration,
    cobuildConfiguration,
    phase,
    operationMetadataManager
  }: {
    buildCacheContext: IOperationBuildCacheContext;
    buildCacheConfiguration: BuildCacheConfiguration | undefined;
    cobuildConfiguration: CobuildConfiguration;
    rushProject: RushConfigurationProject;
    phase: IPhase;
    configHash: string;
    terminal: ITerminal;
    operationMetadataManager: OperationMetadataManager | undefined;
  }): Promise<ProjectBuildCache | undefined> {
    if (!buildCacheConfiguration?.buildCacheEnabled) {
      return;
    }

    const { operationSettings, projectChangeAnalyzer } = buildCacheContext;

    const projectOutputFolderNames: ReadonlyArray<string> = operationSettings?.outputFolderNames ?? [];
    const additionalProjectOutputFilePaths: ReadonlyArray<string> =
      operationMetadataManager?.relativeFilepaths || [];
    const additionalContext: Record<string, string> = {
      // Force the cache to be a log files only cache
      logFilesOnly: '1'
    };
    if (cobuildConfiguration.cobuildContextId) {
      additionalContext.cobuildContextId = cobuildConfiguration.cobuildContextId;
    }

    if (operationSettings) {
      await updateAdditionalContextAsync({
        operationSettings,
        additionalContext,
        projectChangeAnalyzer,
        terminal,
        rushProject
      });
    }

    const projectBuildCache: ProjectBuildCache | undefined = await ProjectBuildCache.tryGetProjectBuildCache({
      project: rushProject,
      projectOutputFolderNames,
      additionalProjectOutputFilePaths,
      additionalContext,
      buildCacheConfiguration,
      terminal,
      configHash,
      projectChangeAnalyzer,
      phaseName: phase.name
    });

    // eslint-disable-next-line require-atomic-updates -- This is guaranteed to not be concurrent
    buildCacheContext.projectBuildCache = projectBuildCache;

    return projectBuildCache;
  }

  private async _tryGetCobuildLockAsync({
    cobuildConfiguration,
    buildCacheContext,
    projectBuildCache,
    packageName,
    phaseName
  }: {
    cobuildConfiguration: CobuildConfiguration | undefined;
    buildCacheContext: IOperationBuildCacheContext;
    projectBuildCache: ProjectBuildCache | undefined;
    packageName: string;
    phaseName: string;
  }): Promise<CobuildLock | undefined> {
    if (!buildCacheContext.cobuildLock) {
      if (projectBuildCache && cobuildConfiguration?.cobuildFeatureEnabled) {
        if (!buildCacheContext.cobuildClusterId) {
          // This should not happen
          throw new InternalError('Cobuild cluster id is not defined');
        }
        buildCacheContext.cobuildLock = new CobuildLock({
          cobuildConfiguration,
          projectBuildCache,
          cobuildClusterId: buildCacheContext.cobuildClusterId,
          lockExpireTimeInSeconds: PERIODIC_CALLBACK_INTERVAL_IN_SECONDS * 3,
          packageName,
          phaseName
        });
      }
    }
    return buildCacheContext.cobuildLock;
  }

  private _getBuildCacheTerminal({
    record,
    buildCacheContext,
    buildCacheEnabled: buildCacheEnabled,
    rushProject,
    logFilenameIdentifier,
    quietMode,
    debugMode
  }: {
    record: OperationExecutionRecord;
    buildCacheContext: IOperationBuildCacheContext;
    buildCacheEnabled: boolean | undefined;
    rushProject: RushConfigurationProject;
    logFilenameIdentifier: string;
    quietMode: boolean;
    debugMode: boolean;
  }): ITerminal {
    if (
      !buildCacheContext.buildCacheTerminal ||
      buildCacheContext.buildCacheProjectLogWritable?.isOpen === false
    ) {
      // The ProjectLogWritable is does not exist or is closed, re-create one
      buildCacheContext.buildCacheTerminal = this._createBuildCacheTerminal({
        record,
        buildCacheContext,
        buildCacheEnabled,
        rushProject,
        logFilenameIdentifier,
        quietMode,
        debugMode
      });
    }

    return buildCacheContext.buildCacheTerminal;
  }

  private _createBuildCacheTerminal({
    record,
    buildCacheContext,
    buildCacheEnabled,
    rushProject,
    logFilenameIdentifier,
    quietMode,
    debugMode
  }: {
    record: OperationExecutionRecord;
    buildCacheContext: IOperationBuildCacheContext;
    buildCacheEnabled: boolean | undefined;
    rushProject: RushConfigurationProject;
    logFilenameIdentifier: string;
    quietMode: boolean;
    debugMode: boolean;
  }): ITerminal {
    const silent: boolean = record.runner.silent;
    if (silent) {
      const nullTerminalProvider: NullTerminalProvider = new NullTerminalProvider();
      return new Terminal(nullTerminalProvider);
    }

    let cacheConsoleWritable: TerminalWritable;
    // This creates the writer, only do this if necessary.
    const collatedWriter: CollatedWriter = record.collatedWriter;
    const cacheProjectLogWritable: ProjectLogWritable | undefined = this._tryGetBuildCacheProjectLogWritable({
      buildCacheContext,
      buildCacheEnabled,
      rushProject,
      collatedTerminal: collatedWriter.terminal,
      logFilenameIdentifier
    });

    if (quietMode) {
      const discardTransform: DiscardStdoutTransform = new DiscardStdoutTransform({
        destination: collatedWriter
      });
      const normalizeNewlineTransform: TextRewriterTransform = new TextRewriterTransform({
        destination: discardTransform,
        normalizeNewlines: NewlineKind.Lf,
        ensureNewlineAtEnd: true
      });
      cacheConsoleWritable = normalizeNewlineTransform;
    } else {
      cacheConsoleWritable = collatedWriter;
    }

    let cacheCollatedTerminal: CollatedTerminal;
    if (cacheProjectLogWritable) {
      const cacheSplitterTransform: SplitterTransform = new SplitterTransform({
        destinations: [cacheConsoleWritable, cacheProjectLogWritable]
      });
      cacheCollatedTerminal = new CollatedTerminal(cacheSplitterTransform);
    } else {
      cacheCollatedTerminal = new CollatedTerminal(cacheConsoleWritable);
    }

    const buildCacheTerminalProvider: CollatedTerminalProvider = new CollatedTerminalProvider(
      cacheCollatedTerminal,
      {
        debugEnabled: debugMode
      }
    );
    return new Terminal(buildCacheTerminalProvider);
  }

  private _tryGetBuildCacheProjectLogWritable({
    buildCacheEnabled,
    rushProject,
    buildCacheContext,
    collatedTerminal,
    logFilenameIdentifier
  }: {
    buildCacheEnabled: boolean | undefined;
    rushProject: RushConfigurationProject;
    buildCacheContext: IOperationBuildCacheContext;
    collatedTerminal: CollatedTerminal;
    logFilenameIdentifier: string;
  }): ProjectLogWritable | undefined {
    // Only open the *.cache.log file(s) if the cache is enabled.
    if (!buildCacheEnabled) {
      return;
    }

    buildCacheContext.buildCacheProjectLogWritable = new ProjectLogWritable(
      rushProject,
      collatedTerminal,
      `${logFilenameIdentifier}.cache`
    );
    return buildCacheContext.buildCacheProjectLogWritable;
  }
}
async function updateAdditionalContextAsync({
  operationSettings,
  additionalContext,
  projectChangeAnalyzer,
  terminal,
  rushProject
}: {
  operationSettings: IOperationSettings;
  additionalContext: Record<string, string>;
  projectChangeAnalyzer: ProjectChangeAnalyzer;
  terminal: ITerminal;
  rushProject: RushConfigurationProject;
}): Promise<void> {
  if (operationSettings.dependsOnEnvVars) {
    for (const varName of operationSettings.dependsOnEnvVars) {
      additionalContext['$' + varName] = process.env[varName] || '';
    }
  }

  if (operationSettings.dependsOnAdditionalFiles) {
    const repoState: IRawRepoState | undefined = await projectChangeAnalyzer._ensureInitializedAsync(
      terminal
    );

    const additionalFiles: Map<string, string> = await getHashesForGlobsAsync(
      operationSettings.dependsOnAdditionalFiles,
      rushProject.projectFolder,
      repoState
    );

    terminal.writeDebugLine(
      `Including additional files to calculate build cache hash:\n  ${Array.from(additionalFiles.keys()).join(
        '\n  '
      )} `
    );

    for (const [filePath, fileHash] of additionalFiles) {
      additionalContext['file://' + filePath] = fileHash;
    }
  }
}

function printBuildPlanMaximumParallelism(operations: Operation[], terminal: ITerminal): number {
  let leafOperations: Operation[] = operations.filter((e) => e.consumers.size === 0);
  let currentLeafNodes = new Set<Operation>();
  let remainingOperations = new Set<Operation>(operations);
  const leafQueue = [...leafOperations];
  let depth = 0;
  let maxWidth = leafQueue.length;
  let numberOfNodes = [leafQueue.length];
  const depthToOperationsMap = new Map<number, Set<Operation>>();
  depthToOperationsMap.set(depth, new Set(leafOperations));
  do {
    if (leafQueue.length === 0) {
      leafQueue.push(...currentLeafNodes);
      const realOperations = [...currentLeafNodes].filter((e) => !e.runner?.isNoOp);
      if (realOperations.length > 0) {
        depth += 1;
        depthToOperationsMap.set(depth, new Set(realOperations));
        numberOfNodes.push(realOperations.length);
      }
      const currentWidth = realOperations.length;
      if (currentWidth > maxWidth) {
        maxWidth = currentWidth;
      }
      currentLeafNodes = new Set();
    }
    if (leafQueue.length === 0) {
      break;
    }
    const leaf = leafQueue.shift()!;
    if (remainingOperations.has(leaf)) {
      remainingOperations.delete(leaf);
      for (const dependent of leaf.dependencies) {
        if (![...dependent.consumers].some((e) => remainingOperations.has(e))) {
          currentLeafNodes.add(dependent);
        }
      }
    }
  } while (remainingOperations.size > 0);

  terminal.writeDebugLine(`Build Plan Depth (deepest dependency tree): ${depth + 1}`);
  terminal.writeDebugLine(`Build Plan Width (maximum parallelism): ${maxWidth}`);
  terminal.writeDebugLine(`Number of Nodes per Depth: ${[...numberOfNodes].reverse().join(', ')}`);
  for (const [operationDepth, operations] of depthToOperationsMap) {
    let numberOfDependents = 0;
    for (let i = 0; i < operationDepth; i++) {
      numberOfDependents += numberOfNodes[i];
    }
    terminal.writeDebugLine(
      `Plan @ Depth ${depth - operationDepth} has ${
        numberOfNodes[operationDepth]
      } nodes and ${numberOfDependents} dependents:`
    );
    for (const operation of operations) {
      if (!operation.runner?.isNoOp) {
        terminal.writeDebugLine(`- ${operation.runner?.name ?? 'unknown'}`);
      }
    }
  }

  return maxWidth;
}

/**
 * Log the cobuild build plan by cluster. This is intended to help debug situations where cobuilds aren't
 *  utilizing multiple agents correctly.
 */
function logCobuildBuildPlan(
  disjointSet: DisjointSet<Operation>,
  terminal: ITerminal,
  buildCacheByOperation: Map<Operation, IOperationBuildCacheContext>
): void {
  // This function should log the tree execution plan, which is a tree of operations that are executed in parallel.
  // It should then log the clusters and their dependencies as well as reasons that those clusters were created.
  // TODO: It should also output the number of operations that have the same depth in the tree.
  const executionPlan: Operation[] = [];
  const clusters: Set<Operation>[] = [...disjointSet.getAllSets()];
  const operations: Operation[] = clusters.flatMap((e) => Array.from(e));
  const rootOperations: Operation[] = operations.filter((e) => e.dependencies.size === 0);

  printBuildPlanMaximumParallelism(operations, terminal);

  // console.log('build plan maximum parallelism', getBuildPlanMaximumParallelism(rootOperations, terminal));

  const getName: (op: Operation) => string = (op: Operation) => op.runner?.name ?? 'unknown';

  const operationToClusterMap: Map<Operation, Set<Operation>> = new Map<Operation, Set<Operation>>();
  for (const cluster of clusters) {
    for (const operation of cluster) {
      operationToClusterMap.set(operation, cluster);
    }
  }

  const queue: Operation[] = [...rootOperations];
  const seen: Set<Operation> = new Set<Operation>();
  while (queue.length > 0) {
    const element: Operation = queue.shift()!;
    if (!seen.has(element) && !element.runner?.isNoOp) {
      executionPlan.push(element);
      seen.add(element);
    }
    const consumers: Operation[] = [...element.consumers].filter((e) => !seen.has(e));
    queue.push(...consumers);
  }

  // Get the maximum name length for left padding.
  const maxOperationNameLength: number = Math.max(
    ...executionPlan.map((e) => e.runner?.name?.length ?? 0),
    1
  );

  // This is a lazy way of getting the waterfall chart, basically check for the latest
  //  dependency and put this operation after that finishes.
  const spacingByDependencyMap: Map<Operation, number> = new Map<Operation, number>();
  for (let index: number = 0; index < executionPlan.length; index++) {
    const operation: Operation = executionPlan[index];

    const spacing: number = Math.max(
      ...[...operation.dependencies].map((e) => {
        const dependencySpacing: number | undefined = spacingByDependencyMap.get(e);
        return dependencySpacing !== undefined ? dependencySpacing + 1 : 0;
      }),
      0
    );
    spacingByDependencyMap.set(operation, spacing);
  }
  executionPlan.sort((a, b) => {
    const aSpacing: number = spacingByDependencyMap.get(a) ?? 0;
    const bSpacing: number = spacingByDependencyMap.get(b) ?? 0;
    return aSpacing - bSpacing;
  });

  terminal.writeDebugLine('##################################################');
  for (const operation of executionPlan) {
    const spacing: number = spacingByDependencyMap.get(operation) ?? 0;
    terminal.writeDebugLine(
      `${getName(operation).padStart(maxOperationNameLength + 1)}: ${'-'.repeat(spacing)}(${clusters.indexOf(
        operationToClusterMap.get(operation)!
      )})`
    );
  }
  terminal.writeDebugLine('##################################################');

  function getDependenciesForCluster(cluster: Set<Operation>): Set<Operation> {
    const dependencies: Set<Operation> = new Set<Operation>();
    for (const operation of cluster) {
      for (const dependent of operation.dependencies) {
        dependencies.add(dependent);
      }
    }
    return dependencies;
  }

  function dedupeShards(ops: Set<Operation>): string[] {
    const dedupedOperations: Set<string> = new Set<string>();
    for (const operation of ops) {
      dedupedOperations.add(
        `${operation.associatedProject?.packageName ?? ''} (${operation.associatedPhase?.name})`
      );
    }
    return [...dedupedOperations];
  }

  for (let clusterIndex: number = 0; clusterIndex < clusters.length; clusterIndex++) {
    const cluster: Set<Operation> = clusters[clusterIndex];
    const allClusterDependencies: Set<Operation> = getDependenciesForCluster(cluster);
    const outOfClusterDependencies: Set<Operation> = new Set(
      [...allClusterDependencies].filter((e) => !cluster.has(e))
    );

    terminal.writeDebugLine(`Cluster ${clusterIndex}:`);
    terminal.writeDebugLine(`- Dependencies: ${dedupeShards(outOfClusterDependencies).join(', ') || 'none'}`);
    terminal.writeDebugLine(
      `- Clustered by: \n${
        [...allClusterDependencies]
          .filter((e) => buildCacheByOperation.get(e)?.cacheDisabledReason)
          .map((e) => `  - (${e.runner?.name}) "${buildCacheByOperation.get(e)?.cacheDisabledReason ?? ''}"`)
          .join('\n') || '  - none'
      }`
    );
    terminal.writeDebugLine(
      `- Operations: ${[...cluster]
        .map((e) => `${getName(e)}${e.runner?.isNoOp ? ' [SKIPPED]' : ''}`)
        .join(', ')}`
    );
    terminal.writeDebugLine('--------------------------------------------------');
  }
  terminal.writeDebugLine('##################################################');
}
