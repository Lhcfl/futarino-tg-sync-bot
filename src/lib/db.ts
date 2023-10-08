import fs from "fs";

export type DBKey = string | number;

class DB {
  private _storage: {
    [dbName in string]: {
      dir: string;
      get path(): string;
      get swpPath(): string;
      writing?: boolean;
      data: {
        map: {
          [key in DBKey]: unknown;
        };
        keys: DBKey[];
      };
    };
  } = {};

  private _planner: {
    [jobName in string]: (() => void)[];
  } = {};

  constructor() {}

  async safeWriteDB(dbName: string) {
    if (this._storage[dbName].writing) {
      console.log("Database is writing, canceling job...");
      return;
    }
    try {
      function writeToPath(dir: string, path: string, data: unknown) {
        try {
          fs.writeFileSync(path, JSON.stringify(data));
        } catch (err) {
          fs.mkdirSync(dir, {
            recursive: true,
          });
          fs.writeFileSync(path, JSON.stringify(data));
        }
      }
      writeToPath(this._storage[dbName].dir, this._storage[dbName].swpPath, this._storage[dbName].data);
      writeToPath(this._storage[dbName].dir, this._storage[dbName].path, this._storage[dbName].data);
    } catch (err) {
      console.error(err);
    }
  }

  safeReadDB(dbName: string) {
    try {
      return JSON.parse(fs.readFileSync(this._storage[dbName].path).toString());
    } catch (err) {
      console.error(err);
      try {
        return JSON.parse(
          fs.readFileSync(this._storage[dbName].swpPath).toString(),
        );
      } catch (err) {
        this.plan(`init-db-${dbName}`, 1, () => this.safeWriteDB(dbName));
        return {
          map: {},
          keys: [],
        };
      }
    }
  }

  /**
   * Stack some tasks together
   * @param jobName Unique Job Name
   * @param waitSeconds If there is no such task yet, wait for `waitSeconds` seconds before starting.
   * @param task The task
   */
  plan(
    jobName: string,
    waitSeconds: number,
    task: () => void,
    options?: {
      override?: boolean;
    },
  ) {
    if (this._planner[jobName]) {
      if (options?.override) {
        this._planner[jobName] = [task];
      } else {
        this._planner[jobName].push(task);
      }
    } else {
      this._planner[jobName] = [task];
      setTimeout(() => {
        this._planner[jobName].forEach((job) => job.call(this));
        delete this._planner[jobName];
      }, waitSeconds * 1000);
    }
  }

  defineDataBase<T>(
    dbName: string,
    options?: {
      dir?: string;
      saveInSeconds?: number;
      autoDeleteInSecond?: number;
      maxSize?: number;
    },
  ) {
    const opt = Object.assign(
      {},
      {
        dir: "./data",
        saveInSeconds: 60,
        autoDeleteInSecond: 86400,
        maxSize: 1000,
      },
      options,
    );

    if (this._storage[dbName]) {
      throw "Repeat database definition";
    }

    this._storage[dbName] = {
      dir: opt.dir,
      get path() {
        return `${this.dir}/${dbName}.json`;
      },
      get swpPath() {
        return `${this.dir}/${dbName}.swp.json`;
      },
      data: {
        map: {},
        keys: [],
      }
    };
    this._storage[dbName].data = this.safeReadDB(dbName);

    const context = {
      this: this,
    };
    return new Proxy(this._storage[dbName].data.map, {
      set: function (db, key: string, value: T) {
        db[key] = value;
        context.this._storage[dbName].data.keys.push(key);
        // Auto delete
        if (opt.autoDeleteInSecond > 0) {
          context.this.plan(
            `clean-old-${dbName}-keys`,
            opt.autoDeleteInSecond,
            () => {
              while (Object.keys(db).length > opt.maxSize) {
                const keyToRemove =
                  context.this._storage[dbName].data.keys.shift();
                if (keyToRemove) delete db[keyToRemove];
              }
            },
          );
        }
        context.this.plan(
          `save-${dbName}`,
          opt.saveInSeconds,
          () => {
            context.this.safeWriteDB(dbName);
          },
          {
            override: true,
          },
        );
        return true;
      },
      get: function (db, key: string): T {
        return db[key] as T;
      },
      deleteProperty: function(db, key: string) {
        delete db[key];
        return true;
      }
    }) as {
      [key in DBKey]: T;
    };
  }
}

export { DB };
export default DB;
