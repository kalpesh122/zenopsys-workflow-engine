import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import { sequelize } from './db';
import type {
  Decision,
  DefinitionBody,
  RunData,
  RunStatus,
  RunTaskStatus,
  Task,
  TaskType,
} from './domain/types';

// `declare` (not class fields) so TS does not shadow Sequelize's attribute getters/setters.

export class WorkflowDefinition extends Model<
  InferAttributes<WorkflowDefinition>,
  InferCreationAttributes<WorkflowDefinition>
> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare startTaskId: string;
  declare tasks: Task[];
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

WorkflowDefinition.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    startTaskId: { type: DataTypes.STRING, allowNull: false },
    tasks: { type: DataTypes.JSONB, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'workflow_definitions', underscored: true },
);

export class WorkflowRun extends Model<InferAttributes<WorkflowRun>, InferCreationAttributes<WorkflowRun>> {
  declare id: CreationOptional<string>;
  declare definitionId: string;
  declare status: RunStatus;
  /** Frozen copy of the definition taken when the run started. The engine reads only this. */
  declare definitionSnapshot: DefinitionBody;
  declare currentTaskId: string | null;
  declare data: RunData;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

WorkflowRun.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    definitionId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workflow_definitions', key: 'id' },
    },
    status: { type: DataTypes.ENUM('active', 'completed', 'cancelled'), allowNull: false },
    definitionSnapshot: { type: DataTypes.JSONB, allowNull: false },
    currentTaskId: { type: DataTypes.STRING, allowNull: true },
    data: { type: DataTypes.JSONB, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'workflow_runs', underscored: true },
);

export class RunTask extends Model<InferAttributes<RunTask>, InferCreationAttributes<RunTask>> {
  declare id: CreationOptional<string>;
  declare runId: string;
  /** Position of this task execution within the run (0-based), assigned under the run lock. */
  declare seq: number;
  declare taskId: string;
  declare type: TaskType;
  declare status: RunTaskStatus;
  declare stepIndex: number;
  /** Answers collected so far (all steps up to the current one). */
  declare draft: Record<string, unknown>;
  /** Final answers once the data-entry task completes. */
  declare output: Record<string, unknown> | null;
  /** Branch tasks only: which rule matched and where the run went. */
  declare decision: Decision | null;
  declare startedAt: Date;
  declare completedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

RunTask.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    runId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workflow_runs', key: 'id' },
    },
    seq: { type: DataTypes.INTEGER, allowNull: false },
    taskId: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.ENUM('active', 'completed', 'cancelled'), allowNull: false },
    stepIndex: { type: DataTypes.INTEGER, allowNull: false },
    draft: { type: DataTypes.JSONB, allowNull: false },
    output: { type: DataTypes.JSONB, allowNull: true },
    decision: { type: DataTypes.JSONB, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: false },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'run_tasks',
    underscored: true,
    indexes: [
      // Database-level invariant: a run has at most one active task.
      { name: 'one_active_task_per_run', unique: true, fields: ['run_id'], where: { status: 'active' } },
      { name: 'run_tasks_run_seq', unique: true, fields: ['run_id', 'seq'] },
    ],
  },
);
