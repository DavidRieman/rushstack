// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { SyncHook } from 'tapable';

import type { HeftPluginDefinitionBase } from '../configuration/HeftPluginDefinition';
import type { IHeftPlugin } from './IHeftPlugin';

export abstract class HeftPluginHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _pluginAccessRequestHooks: Map<string, SyncHook<any>> = new Map();

  public abstract applyPluginsAsync(): Promise<void>;

  public requestAccessToPluginByName<T extends object>(
    requestorName: string,
    pluginToAccessPackage: string,
    pluginToAccessName: string,
    accessorCallback: (pluginAccessor: T) => void
  ): void {
    const pluginHookName: string = this.getPluginHookName(pluginToAccessPackage, pluginToAccessName);
    let pluginAccessRequestHook: SyncHook<T> | undefined = this._pluginAccessRequestHooks.get(pluginHookName);
    if (!pluginAccessRequestHook) {
      pluginAccessRequestHook = new SyncHook(['pluginAccessor']);
      this._pluginAccessRequestHooks.set(pluginHookName, pluginAccessRequestHook);
    }
    if (pluginAccessRequestHook.taps.some((t) => t.name === requestorName)) {
      throw new Error(
        `Plugin "${pluginToAccessName}" from "${pluginToAccessPackage}" has already been accessed ` +
          `by "${requestorName}".`
      );
    }
    pluginAccessRequestHook.tap(requestorName, accessorCallback);
  }

  public getPluginHookName(pluginPackageName: string, pluginName: string): string {
    return `${pluginPackageName};${pluginName}`;
  }

  protected resolvePluginAccessRequests(
    plugin: IHeftPlugin,
    pluginDefinition: HeftPluginDefinitionBase
  ): void {
    const pluginHookName: string = this.getPluginHookName(
      pluginDefinition.pluginPackageName,
      pluginDefinition.pluginName
    );
    const pluginAccessRequestHook: SyncHook<object> | undefined =
      this._pluginAccessRequestHooks.get(pluginHookName);
    if (pluginAccessRequestHook?.isUsed()) {
      const accessor: object | undefined = plugin.accessor;
      if (accessor) {
        pluginAccessRequestHook.call(accessor);
      } else {
        throw new Error(
          `Plugin "${pluginDefinition.pluginName}" from package "${pluginDefinition.pluginPackageName}" ` +
            'does not provide an accessor property, so it does not provide access to other plugins.'
        );
      }
    }
  }
}
