// npm-check-updates settings. scripts/src/check-new-deps.ts uses them to fail
// a change that adds a dependency, or changes its version, to anything older
// than the newest release pnpm's minimumReleaseAge lets us install.
//
// To hold a dependency back on purpose, add it to `reject` with a comment
// saying why, for example:
//
//   reject: [
//     // @types/foo only covers 1.x, and foo 2 ships no types of its own
//     "foo",
//   ],
//
// A rejected dependency is skipped entirely, so take it off again once the
// reason is gone.
module.exports = {
  reject: [],
};
