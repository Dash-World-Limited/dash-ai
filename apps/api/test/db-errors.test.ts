import { describe, expect, it } from "vitest";
import { databaseFailure } from "../src/store/dbErrors.js";

describe("database failure classification", () => {
  const err = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});
  it("recognises an exhausted pool, a lost connection and a statement timeout", () => {
    expect(databaseFailure(err("timeout exceeded when trying to connect"))).toBe("pool_timeout");
    expect(databaseFailure(err("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED"))).toBe("connection");
    expect(databaseFailure(err("Connection terminated unexpectedly"))).toBe("connection");
    expect(databaseFailure(err("terminating connection due to administrator command", "57P01"))).toBe("connection");
    expect(databaseFailure(err("sorry, too many clients already", "53300"))).toBe("connection");
    expect(databaseFailure(err("connection failure", "08006"))).toBe("connection");
    expect(databaseFailure(err("canceling statement due to statement timeout", "57014"))).toBe("statement_timeout");
  });
  it("leaves bugs and constraint errors alone (they stay internal errors)", () => {
    expect(databaseFailure(err("duplicate key value", "23505"))).toBeNull();
    expect(databaseFailure(err("syntax error", "42601"))).toBeNull();
    expect(databaseFailure(new TypeError("x is undefined"))).toBeNull();
    expect(databaseFailure("not an error")).toBeNull();
  });
});
