/**
 * Pure functions shared by the `allclear` Workers.
 *
 * Everything exported from here is deterministic and free of I/O, so both
 * Workers can call it, and so it can be tested without a runtime. That is the
 * whole reason the package exists: the availability maths and the status
 * derivation are the two places where being wrong is expensive and silent, and
 * neither should be entangled with a database handle.
 */

export * from "./status";
export * from "./snapshot";
export * from "./uptime";
// The Atom feed is here for the same reason as the rest: it is a pure function of
// the snapshot, and both Workers serve it. See the header of `feed.ts`.
export * from "./feed";
