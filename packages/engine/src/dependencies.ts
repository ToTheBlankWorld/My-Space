import type {
  EngineAction,
  PlanningConflict,
  PlanningDependency,
  PlanningInput,
  PlanningTask,
  ScheduledBlock,
  UnscheduledTask,
} from './types';

/**
 * Dependency engine.
 *
 * Ensures prerequisite ordering: a task cannot be scheduled until all its
 * dependencies are scheduled *before* it. Cycle detection prevents infinite
 * loops in malformed dependency graphs.
 *
 * The algorithm:
 *   1. Build a dependency graph from PlanningDependency edges.
 *   2. Topologically sort tasks (Kahn's algorithm).
 *   3. Detect cycles (unschedulable tasks get DEPENDENCY_CYCLE conflict).
 *   4. For each task in topological order, verify all prerequisites are
 *      already scheduled before this task starts.
 *   5. If a prerequisite is missing, the dependent task is deferred.
 *
 * Pure function: no side effects.
 */
export const resolveDependencies = (
  input: PlanningInput,
  scheduled: ScheduledBlock[],
  unscheduled: UnscheduledTask[],
): {
  scheduled: ScheduledBlock[];
  unscheduled: UnscheduledTask[];
  conflicts: PlanningConflict[];
  actions: EngineAction[];
} => {
  const { dependencies, tasks } = input;
  const actions: EngineAction[] = [];

  // Build adjacency list.
  const taskIds = new Set(tasks.map((t) => t.id));
  const adj = new Map<string, Set<string>>(); // taskId → set of taskIds it depends on
  const inDegree = new Map<string, number>();

  for (const tid of taskIds) {
    adj.set(tid, new Set());
    inDegree.set(tid, 0);
  }

  for (const dep of dependencies) {
    if (!taskIds.has(dep.taskId) || !taskIds.has(dep.dependsOnId)) continue;

    adj.get(dep.dependsOnId)!.add(dep.taskId);
    inDegree.set(dep.taskId, (inDegree.get(dep.taskId) ?? 0) + 1);
  }

  // Kahn's algorithm for topological sort.
  const queue: string[] = [];
  for (const [tid, deg] of inDegree) {
    if (deg === 0) queue.push(tid);
  }

  // Sort queue for deterministic ordering.
  queue.sort();

  const topoOrder: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    topoOrder.push(current);

    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }

    queue.sort(); // deterministic
  }

  // Detect cycles: any task not in topoOrder is part of a cycle.
  const conflicts: PlanningConflict[] = [];
  const cycleTaskIds = new Set<string>();

  for (const tid of taskIds) {
    if (!topoOrder.includes(tid)) {
      cycleTaskIds.add(tid);
      const task = tasks.find((t) => t.id === tid);

      conflicts.push({
        type: 'DEPENDENCY_CYCLE',
        itemIds: [tid],
        description: `Task "${task?.title ?? tid}" is part of a dependency cycle.`,
        resolution: `Task excluded from scheduling due to circular dependency.`,
        reasonCode: 'HARD_DEPENDENCY_BLOCKED',
      });

      actions.push({
        actionType: 'TASK_DEFERRED',
        entityType: 'TASK',
        entityId: tid,
        reason: `Dependency cycle detected for task "${task?.title ?? tid}".`,
        reasonCode: 'HARD_DEPENDENCY_BLOCKED',
        factors: { dependencies: [...adj.get(tid)!] },
      });
    }
  }

  // Verify prerequisite ordering in scheduled blocks.
  const scheduledMap = new Map<string, ScheduledBlock>();
  for (const block of scheduled) {
    if (block.kind === 'TASK') {
      scheduledMap.set(block.itemId, block);
    }
  }

  const displaced: string[] = [];

  for (const dep of dependencies) {
    if (cycleTaskIds.has(dep.taskId) || cycleTaskIds.has(dep.dependsOnId)) continue;
    if (!taskIds.has(dep.taskId) || !taskIds.has(dep.dependsOnId)) continue;

    const dependentBlock = scheduledMap.get(dep.taskId);
    const prerequisiteBlock = scheduledMap.get(dep.dependsOnId);

    if (dependentBlock && prerequisiteBlock) {
      // Prerequisite must end before dependent starts.
      if (prerequisiteBlock.end.getTime() > dependentBlock.start.getTime()) {
        displaced.push(dep.taskId);

        const dependent = tasks.find((t) => t.id === dep.taskId);
        const prerequisite = tasks.find((t) => t.id === dep.dependsOnId);

        conflicts.push({
          type: 'DEPENDENCY_MISSING_PREREQUISITE',
          itemIds: [dep.taskId, dep.dependsOnId],
          description: `"${dependent?.title ?? dep.taskId}" depends on "${prerequisite?.title ?? dep.dependsOnId}" but is scheduled before it finishes.`,
          resolution: `Task deferred until prerequisite completes.`,
          reasonCode: 'HARD_DEPENDENCY_BLOCKED',
        });
      }
    }
  }

  // Remove displaced tasks from scheduled.
  const finalScheduled = scheduled.filter((b) => !displaced.includes(b.itemId));

  // Add displaced tasks to unscheduled.
  for (const taskId of displaced) {
    if (!unscheduled.some((u) => u.taskId === taskId)) {
      const task = tasks.find((t) => t.id === taskId);
      unscheduled.push({
        taskId,
        reasonCode: 'UNSCHEDULED_DEPENDENCY_CHAIN',
        message: `Task "${task?.title ?? taskId}" deferred due to dependency ordering.`,
      });
    }
  }

  // Also add cycle tasks to unscheduled.
  for (const cycleId of cycleTaskIds) {
    if (!unscheduled.some((u) => u.taskId === cycleId)) {
      const task = tasks.find((t) => t.id === cycleId);
      unscheduled.push({
        taskId: cycleId,
        reasonCode: 'UNSCHEDULED_DEPENDENCY_CHAIN',
        message: `Task "${task?.title ?? cycleId}" excluded: dependency cycle.`,
      });
    }
  }

  return { scheduled: finalScheduled, unscheduled, conflicts, actions };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const hasCycle = (
  tasks: readonly PlanningTask[],
  dependencies: readonly PlanningDependency[],
): boolean => {
  const taskIds = new Set(tasks.map((t) => t.id));
  const adj = new Map<string, Set<string>>();

  for (const tid of taskIds) adj.set(tid, new Set());

  for (const dep of dependencies) {
    if (!taskIds.has(dep.taskId) || !taskIds.has(dep.dependsOnId)) continue;
    adj.get(dep.dependsOnId)!.add(dep.taskId);
  }

  // DFS-based cycle detection.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const tid of taskIds) color.set(tid, WHITE);

  const dfs = (node: string): boolean => {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) return true;
      if (color.get(neighbor) === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  };

  for (const tid of taskIds) {
    if (color.get(tid) === WHITE && dfs(tid)) return true;
  }

  return false;
};
