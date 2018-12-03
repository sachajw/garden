/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as Bluebird from "bluebird"
import * as PQueue from "p-queue"
import chalk from "chalk"
import * as yaml from "js-yaml"
import { merge, padEnd, pick, flatten } from "lodash"
import { BaseTask, TaskDefinitionError } from "./tasks/base"

import { LogEntry } from "./logger/log-entry"
import { toGardenError } from "./exceptions"
import { Garden } from "./garden"

class TaskGraphError extends Error { }

export interface TaskResult {
  type: string
  description: string
  output?: any
  dependencyResults?: TaskResults
  error?: Error
}

/**
 * When multiple tasks with the same baseKey are completed during a call to processTasks,
 * the result from the last processed is used (hence only one key-value pair here per baseKey).
 */
export interface TaskResults {
  [baseKey: string]: TaskResult
}

export const DEFAULT_CONCURRENCY = 4

export class TaskGraph {
  private roots: TaskNodeMap
  private index: TaskNodeMap

  private inProgress: TaskNodeMap
  private logEntryMap: LogEntryMap

  /**
   * A given task instance (uniquely identified by its key) should always return the same
   * list of dependencies (by baseKey) from its getDependencies method.
   */
  private taskDependencyCache: { [key: string]: Set<string> } // sets of baseKeys

  private resultCache: ResultCache
  private opQueue: PQueue

  constructor(private garden: Garden, private log: LogEntry, private concurrency: number = DEFAULT_CONCURRENCY) {
    this.roots = new TaskNodeMap()
    this.index = new TaskNodeMap()
    this.inProgress = new TaskNodeMap()
    this.taskDependencyCache = {}
    this.resultCache = new ResultCache()
    this.opQueue = new PQueue({ concurrency: 1 })
    this.logEntryMap = {}
  }

  async addTask(task: BaseTask): Promise<void> {
    return this.opQueue.add(() => this.addTaskInternal(task))
  }

  async processTasks(): Promise<TaskResults> {
    return this.opQueue.add(() => this.processTasksInternal())
  }

  /**
   * Rebuilds the dependency relationships between the TaskNodes in this.index, and updates this.roots accordingly.
   */
  private async rebuild() {
    const taskNodes = this.index.getNodes()

    // this.taskDependencyCache will already have been populated at this point (happens in addTaskInternal).
    for (const node of taskNodes) {
      /**
       * We set the list of dependency nodes to the intersection of the set of nodes in this.index with
       * the node's task's dependencies (from configuration).
       */
      node.clear()
      const taskDeps = this.taskDependencyCache[node.getKey()] || new Set()
      node.setDependencies(taskNodes.filter(n => taskDeps.has(n.getBaseKey())))
    }

    const newRootNodes = taskNodes.filter(n => n.getDependencies().length === 0)
    this.roots.clear()
    this.roots.setNodes(newRootNodes)
  }

  private async addTaskInternal(task: BaseTask) {
    this.garden.events.emit("taskPending", {
      addedAt: new Date(),
      key: task.getKey(),
      version: task.version,
    })
    await this.addNodeWithDependencies(task)
    await this.rebuild()
  }

  private getNode(task: BaseTask): TaskNode | null {
    const key = task.getKey()
    const baseKey = task.getBaseKey()
    const existing = this.index.getNodes()
      .filter(n => n.getBaseKey() === baseKey && n.getKey() !== key)
      .reverse()[0]

    if (existing) {
      // A task with the same baseKey is already pending.
      return existing
    } else {
      const cachedResultExists = !!this.resultCache.get(task.getBaseKey(), task.version.versionString)
      if (cachedResultExists && !task.force) {
        // No need to add task or its dependencies.
        return null
      } else {
        return new TaskNode((task))
      }
    }
  }

  /**
   * Process the graph until it's complete.
   */
  private async processTasksInternal(): Promise<TaskResults> {
    this.log.silly("")
    this.log.silly("TaskGraph: this.index before processing")
    this.log.silly("---------------------------------------")
    this.log.silly(yaml.safeDump(this.index.inspect(), { noRefs: true, skipInvalid: true }))

    const _this = this
    const results: TaskResults = {}

    const loop = async () => {
      if (_this.index.length === 0) {
        // done!
        this.logEntryMap.counter && this.logEntryMap.counter.setDone({ symbol: "info" })
        return
      }

      const batch = _this.roots.getNodes()
        .filter(n => !this.inProgress.contains(n))
        .slice(0, _this.concurrency - this.inProgress.length)

      batch.forEach(n => this.inProgress.addNode(n))
      await this.rebuild()

      this.initLogging()

      return Bluebird.map(batch, async (node: TaskNode) => {
        const task = node.task
        const type = node.getType()
        const baseKey = node.getBaseKey()
        const description = node.getDescription()
        let result

        try {
          this.logTask(node)
          this.logEntryMap.inProgress.setState(inProgressToStr(this.inProgress.getNodes()))

          const dependencyBaseKeys = (await task.getDependencies())
            .map(dep => dep.getBaseKey())

          const dependencyResults = merge(
            this.resultCache.pick(dependencyBaseKeys),
            pick(results, dependencyBaseKeys))

          try {
            result = await node.process(dependencyResults)
            this.garden.events.emit("taskComplete", result)
          } catch (error) {
            result = { type, description, error }
            this.garden.events.emit("taskError", result)
            this.logTaskError(node, error)
            await this.cancelDependants(node)
          } finally {
            results[baseKey] = result
            this.resultCache.put(baseKey, task.version.versionString, result)
          }
        } finally {
          await this.completeTask(node, !result.error)
        }

        return loop()
      })
    }

    await loop()

    await this.rebuild()

    return results
  }

  private addNode(task: BaseTask): TaskNode | null {
    const node = this.getNode(task)
    if (node) {
      this.index.addNode(node)
    }
    return node
  }

  private async addNodeWithDependencies(task: BaseTask) {
    const node = this.addNode(task)

    if (node) {
      const depTasks = await node.task.getDependencies()
      this.taskDependencyCache[node.getKey()] = new Set(depTasks.map(d => d.getBaseKey()))
      for (const dep of depTasks) {
        await this.addNodeWithDependencies(dep)
      }
    }
  }

  private async completeTask(node: TaskNode, success: boolean) {
    if (node.getDependencies().length > 0) {
      throw new TaskGraphError(`Task ${node.getKey()} still has unprocessed dependencies`)
    }

    this.remove(node)
    this.logTaskComplete(node, success)
    await this.rebuild()
  }

  private remove(node: TaskNode) {
    this.index.removeNode(node)
    this.inProgress.removeNode(node)
  }

  // Recursively remove node's dependants, without removing node.
  private async cancelDependants(node: TaskNode) {
    for (const dependant of this.getDependants(node)) {
      this.logTaskComplete(dependant, false)
      this.remove(dependant)
    }
    await this.rebuild()
  }

  private getDependants(node: TaskNode): TaskNode[] {
    const dependants = this.index.getNodes().filter(n => n.getDependencies()
      .find(d => d.getBaseKey() === node.getBaseKey()))
    return dependants.concat(flatten(dependants.map(d => this.getDependants(d))))
  }

  // Logging
  private logTask(node: TaskNode) {
    const entry = this.log.debug({
      section: "tasks",
      msg: `Processing task ${taskStyle(node.getKey())}`,
      status: "active",
    })
    this.logEntryMap[node.getKey()] = entry
  }

  private logTaskComplete(node: TaskNode, success: boolean) {
    const entry = this.logEntryMap[node.getKey()]
    if (entry) {
      success ? entry.setSuccess() : entry.setError()
    }
    this.logEntryMap.counter.setState(remainingTasksToStr(this.index.length))
  }

  private initLogging() {
    if (!Object.keys(this.logEntryMap).length) {
      const header = this.log.debug("Processing tasks...")
      const counter = this.log.debug({
        msg: remainingTasksToStr(this.index.length),
        status: "active",
      })
      const inProgress = this.log.debug(inProgressToStr(this.inProgress.getNodes()))
      this.logEntryMap = {
        ...this.logEntryMap,
        header,
        counter,
        inProgress,
      }
    }
  }

  private logTaskError(node: TaskNode, err) {
    const divider = padEnd("", 80, "—")
    const error = toGardenError(err)
    const msg = `\nFailed ${node.getDescription()}. Here is the output:\n${divider}\n${error.message}\n${divider}\n`
    this.log.error({ msg, error })
  }
}

function getIndexKey(task: BaseTask) {
  const key = task.getKey()

  if (!task.type || !key || task.type.length === 0 || key.length === 0) {
    throw new TaskDefinitionError("Tasks must define a type and a key")
  }

  return key
}

class TaskNodeMap {
  // Map is used here to facilitate in-order traversal.
  index: Map<string, TaskNode>
  length: number

  constructor() {
    this.index = new Map()
    this.length = 0
  }

  getNode(task: BaseTask) {
    const indexKey = getIndexKey(task)
    const element = this.index.get(indexKey)
    return element
  }

  addNode(node: TaskNode): void {
    const indexKey = node.getKey()

    if (!this.index.get(indexKey)) {
      this.index.set(indexKey, node)
      this.length++
    }
  }

  removeNode(node: TaskNode): void {
    if (this.index.delete(node.getKey())) {
      this.length--
    }
  }

  setNodes(nodes: TaskNode[]): void {
    for (const node of nodes) {
      this.addNode(node)
    }
  }

  getNodes(): TaskNode[] {
    return Array.from(this.index.values())
  }

  contains(node: TaskNode): boolean {
    return this.index.has(node.getKey())
  }

  clear() {
    this.index.clear()
    this.length = 0
  }

  // For testing/debugging purposes
  inspect(): object {
    const out = {}
    this.index.forEach((node, key) => {
      out[key] = node.inspect()
    })
    return out
  }

}

class TaskNode {
  task: BaseTask

  private dependencies: TaskNodeMap

  constructor(task: BaseTask) {
    this.task = task
    this.dependencies = new TaskNodeMap()
  }

  clear() {
    this.dependencies.clear()
  }

  setDependencies(nodes: TaskNode[]) {
    for (const node of nodes) {
      this.dependencies.addNode(node)
    }
  }
  getDependencies() {
    return this.dependencies.getNodes()
  }

  getBaseKey() {
    return this.task.getBaseKey()
  }

  getKey() {
    return getIndexKey(this.task)
  }

  getDescription() {
    return this.task.getDescription()
  }

  getType() {
    return this.task.type
  }

  // For testing/debugging purposes
  inspect(): object {
    return {
      key: this.getKey(),
      dependencies: this.getDependencies().map(d => d.inspect()),
    }
  }

  async process(dependencyResults: TaskResults) {
    const output = await this.task.process(dependencyResults)

    return {
      type: this.getType(),
      description: this.getDescription(),
      output,
      dependencyResults,
    }
  }
}

interface CachedResult {
  result: TaskResult,
  versionString: string
}

class ResultCache {
  /**
   * By design, at most one TaskResult (the most recently processed) is cached for a given baseKey.
   *
   * Invariant: No concurrent calls are made to this class' instance methods, since they
   * only happen within TaskGraph's addTaskInternal and processTasksInternal methods,
   * which are never executed concurrently, since they are executed sequentially by the
   * operation queue.
   */
  private cache: { [key: string]: CachedResult }

  constructor() {
    this.cache = {}
  }

  put(baseKey: string, versionString: string, result: TaskResult): void {
    this.cache[baseKey] = { result, versionString }
  }

  get(baseKey: string, versionString: string): TaskResult | null {
    const r = this.cache[baseKey]
    return (r && r.versionString === versionString && !r.result.error) ? r.result : null
  }

  getNewest(baseKey: string): TaskResult | null {
    const r = this.cache[baseKey]
    return (r && !r.result.error) ? r.result : null
  }

  // Returns newest cached results, if any, for baseKeys
  pick(baseKeys: string[]): TaskResults {
    const results: TaskResults = {}

    for (const baseKey of baseKeys) {
      const cachedResult = this.getNewest(baseKey)
      if (cachedResult) {
        results[baseKey] = cachedResult
      }
    }

    return results
  }

}

interface LogEntryMap { [key: string]: LogEntry }

const taskStyle = chalk.cyan.bold

function inProgressToStr(nodes) {
  return `Currently in progress [${nodes.map(n => taskStyle(n.getKey())).join(", ")}]`
}

function remainingTasksToStr(num) {
  const style = num === 0 ? chalk.green : chalk.yellow
  return `Remaining tasks ${style.bold(String(num))}`
}
