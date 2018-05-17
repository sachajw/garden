/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { BooleanParameter, Command, ParameterValues, StringParameter } from "./base"
import { PluginContext } from "../plugin-context"
import { Module } from "../types/module"
import { PushTask } from "../tasks/push"
import { RuntimeError } from "../exceptions"
import { TaskResults } from "../task-graph"

export const pushArgs = {
  module: new StringParameter({
    help: "The name of the module(s) to push (skip to push all modules). " +
      "Use comma as separator to specify multiple modules.",
  }),
}

export const pushOpts = {
  "force-build": new BooleanParameter({
    help: "Force rebuild of module(s) before pushing",
  }),
  "allow-dirty": new BooleanParameter({
    help: "Allow pushing dirty builds (with untracked/uncommitted files)",
  }),
}

export type Args = ParameterValues<typeof pushArgs>
export type Opts = ParameterValues<typeof pushOpts>

export class PushCommand extends Command<typeof pushArgs, typeof pushOpts> {
  name = "push"
  help = "Build and push module(s) to remote registry"

  arguments = pushArgs
  options = pushOpts

  async action(ctx: PluginContext, args: Args, opts: Opts) {
    ctx.log.header({ emoji: "rocket", command: "Push modules" })

    const names = args.module ? args.module.split(",") : undefined
    const modules = await ctx.getModules(names)

    const result = await pushModules(ctx, modules, !!opts["force-build"], !!opts["allow-dirty"])

    ctx.log.info({ msg: "" })
    ctx.log.info({ emoji: "heavy_check_mark", msg: chalk.green("Done!\n") })

    return result
  }
}

export async function pushModules(
  ctx: PluginContext,
  modules: Module<any>[],
  forceBuild: boolean,
  allowDirty: boolean,
): Promise<TaskResults> {
  for (const module of modules) {
    const version = await module.getVersion()

    if (version.dirtyTimestamp && !allowDirty) {
      throw new RuntimeError(
        `Module ${module.name} has uncommitted changes. ` +
        `Please commit them, clean the module's source tree or set the --allow-dirty flag to override.`,
        { moduleName: module.name, version },
      )
    }

    const task = new PushTask(ctx, module, forceBuild)
    await ctx.addTask(task)
  }

  return await ctx.processTasks()
}
