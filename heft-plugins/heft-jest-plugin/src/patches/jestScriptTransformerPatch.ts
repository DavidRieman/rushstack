// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { Import, FileSystem } from '@rushstack/node-core-library';

// This patch is to disable cache reads/writes in Jest. Cache reads/writes add overhead I/O to running Jest
// with the heft-jest-plugin, since cache files for the heft typescript jest transformer simply read a file
// from disk and feed it to Jest. In addition, cache interaction has lead to some issues with Jest in the
// past, such as a race condition when attempting to rename the target cache file (see:
// https://github.com/facebook/jest/issues/4444). Passing '--no-cache' to Jest simply tells Jest to not read
// the produced cache files, but does nothing to prevent writing of these files. This patch disables both
// reading and writing of cache files.

interface IScriptTransformerModule {
  createScriptTransformer: unknown;
  createTranspilingRequire: unknown;
}

const patchName: string = path.basename(__filename);

function applyPatch(): void {
  try {
    // Resolve the ScriptTransformer module in the "@jest/transform" package relative to the
    // heft-jest-plugin package
    const scriptTransformerFilePath: string = Import.resolveModule({
      modulePath: '@jest/transform/build/ScriptTransformer',
      baseFolderPath: __dirname
    });
    const scriptTransformerFilename: string = path.basename(scriptTransformerFilePath); // ScriptTransformer.js

    // Load the module
    const scriptTransformerModule: IScriptTransformerModule = require(scriptTransformerFilePath);

    // Obtain the metadata for the module
    let scriptTransformerModuleMetadata: NodeModule | undefined = undefined;
    for (const childModule of module.children) {
      if (
        path.basename(childModule.filename || '').toUpperCase() === scriptTransformerFilename.toUpperCase()
      ) {
        if (scriptTransformerModuleMetadata) {
          throw new Error('More than one child module matched while detecting Node.js module metadata');
        }
        scriptTransformerModuleMetadata = childModule;
      }
    }

    // Load the original file contents
    const originalFileContent: string = FileSystem.readFile(scriptTransformerFilePath);

    // Add boilerplate so that eval() will return the exports
    let patchedCode: string =
      '// PATCHED BY HEFT USING eval()\n\nexports = {}\n' +
      originalFileContent +
      '\n// return value:\nexports';

    // Patch the file contents
    patchedCode = patchCacheFileFunction('readCacheFile', scriptTransformerFilePath, patchedCode);
    patchedCode = patchCacheFileFunction('writeCacheFile', scriptTransformerFilePath, patchedCode);

    function evalInContext(): IScriptTransformerModule {
      // Remap the require() function for the eval() context

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function require(modulePath: string): void {
        return scriptTransformerModuleMetadata!.require(modulePath);
      }

      // eslint-disable-next-line no-eval
      return eval(patchedCode);
    }

    const patchedModule: IScriptTransformerModule = evalInContext();
    scriptTransformerModule.createScriptTransformer = patchedModule.createScriptTransformer;
    scriptTransformerModule.createTranspilingRequire = patchedModule.createTranspilingRequire;
  } catch (e) {
    console.error();
    console.error(`ERROR: ${patchName} failed to patch the "@jest/transform" package:`);
    console.error((e as Error).toString());
    console.error();

    throw e;
  }
}

function patchCacheFileFunction(
  functionName: 'readCacheFile' | 'writeCacheFile',
  scriptPath: string,
  scriptContent: string
): string {
  // This patch is going to be very specific to the version of Jest that we are using.
  // This is intentional, because we want to make sure that we don't accidentally break
  // future versions of Jest that might have a different implementation.
  //
  // We will replace the existing implementation of the method to no-op.
  const match: RegExpMatchArray | null = scriptContent.match(new RegExp(`^\\s*const ${functionName} =`, 'm'));
  if (!match) {
    throw new Error(
      `The ${JSON.stringify(functionName)} function was not found in the file ${JSON.stringify(scriptPath)}`
    );
  }

  const startIndex: number = match.index!;
  const endIndex: number = scriptContent.indexOf('};', startIndex) + 2;
  scriptContent =
    scriptContent.slice(0, startIndex) + `const ${functionName} = () => {};` + scriptContent.slice(endIndex);

  return scriptContent;
}

if (typeof jest !== 'undefined' || process.env.JEST_WORKER_ID) {
  // This patch is incompatible with Jest's proprietary require() implementation
  console.log(`\nJEST ENVIRONMENT DETECTED - Skipping Heft's ${patchName}\n`);
} else {
  applyPatch();
}
