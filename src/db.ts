import { Sequelize } from 'sequelize';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/workflow';

export const sequelize = new Sequelize(url, { dialect: 'postgres', logging: false });

/**
 * Creates tables from the models (models must already be imported).
 * Production would use versioned migrations instead of sync().
 */
export async function initDb(): Promise<void> {
  await sequelize.authenticate();
  await sequelize.sync();
}
