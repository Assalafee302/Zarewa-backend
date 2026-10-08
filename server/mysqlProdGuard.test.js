import { describe, it, expect, afterEach } from 'vitest';
import {
  isProductionMysqlDatabaseName,
  assertNotProductionMysqlDatabase,
  assertVitestNotUsingProductionMysql,
} from './mysqlProdGuard.js';

describe('mysqlProdGuard', () => {
  const prev = {
    PROD_NAMES: process.env.ZAREWA_MYSQL_PROD_DATABASE_NAMES,
    DATABASE: process.env.ZAREWA_MYSQL_DATABASE,
    TEST: process.env.ZAREWA_MYSQL_TEST_DATABASE,
    E2E: process.env.ZAREWA_MYSQL_E2E_DATABASE,
  };

  afterEach(() => {
    const map = {
      PROD_NAMES: 'ZAREWA_MYSQL_PROD_DATABASE_NAMES',
      DATABASE: 'ZAREWA_MYSQL_DATABASE',
      TEST: 'ZAREWA_MYSQL_TEST_DATABASE',
      E2E: 'ZAREWA_MYSQL_E2E_DATABASE',
    };
    for (const [k, envKey] of Object.entries(map)) {
      const v = prev[k];
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  });

  it('flags Hostinger production schema names', () => {
    expect(isProductionMysqlDatabaseName('u172282559_ZAREWA')).toBe(true);
    expect(isProductionMysqlDatabaseName('u999_ZAREWA')).toBe(true);
  });

  it('allows local / test schemas', () => {
    expect(isProductionMysqlDatabaseName('zarewa_test')).toBe(false);
    expect(isProductionMysqlDatabaseName('zarewa_test_w1')).toBe(false);
    expect(isProductionMysqlDatabaseName('zarewa_db')).toBe(false);
    expect(isProductionMysqlDatabaseName('zarewa_e2e')).toBe(false);
  });

  it('honours ZAREWA_MYSQL_PROD_DATABASE_NAMES extras', () => {
    process.env.ZAREWA_MYSQL_PROD_DATABASE_NAMES = 'acme_live, other_prod';
    expect(isProductionMysqlDatabaseName('acme_live')).toBe(true);
    expect(isProductionMysqlDatabaseName('other_prod')).toBe(true);
    expect(isProductionMysqlDatabaseName('zarewa_test')).toBe(false);
  });

  it('assertNotProductionMysqlDatabase throws for prod', () => {
    expect(() => assertNotProductionMysqlDatabase('u172282559_ZAREWA', 'wipe')).toThrow(
      /Refusing wipe/
    );
  });

  it('assertVitestNotUsingProductionMysql throws when env DB is prod', () => {
    process.env.ZAREWA_MYSQL_DATABASE = 'u172282559_ZAREWA';
    delete process.env.ZAREWA_MYSQL_TEST_DATABASE;
    expect(() => assertVitestNotUsingProductionMysql()).toThrow(/Refusing to run Vitest/);
  });
});
