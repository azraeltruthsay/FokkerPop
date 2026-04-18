# Update Safety Plan

This plan ensures that users can update FokkerPop by simply extracting the new release zip over their existing folder without losing their custom settings, goals, or redeems.

## Objective
Make the update process seamless and safe by preventing user-modified files (`goals.json`, `redeems.json`) from being bundled and overwritten by the release zip.

## Scope & Impact
- **Repo Structure:** Rename `goals.json` to `goals.example.json` and `redeems.json` to `redeems.example.json`.
- **Initialization Logic:** `server/index.js` will look for the real `.json` file first. If it's missing, it will read the `.example.json` file, create the real `.json` file with that content, and load it.
- **Build Pipeline:** Update `.github/workflows/release.yml` to bundle the `.example.json` files instead of the real ones.
- **Documentation:** Update `README.md` to instruct users to simply extract the new zip over their existing folder.

## Implementation Steps

1. **Rename Files:**
   - Use `git mv` to rename `goals.json` -> `goals.example.json` and `redeems.json` -> `redeems.example.json`.
2. **Update `server/index.js`:**
   - Replace the simple `loadJson` function with a robust `loadAndEnsureJson(name, defaultData)` function.
   - It will check `name`, then fallback to `name`'s `.example.json` equivalent, write the result to `name`, and return it.
3. **Update Release Workflow:**
   - Modify `.github/workflows/release.yml` to include `goals.example.json` and `redeems.example.json` in the release zip.
4. **Update `README.md`:**
   - Change the "Updating" instructions to simplify the process.

## Verification
- Verify `goals.json` and `redeems.json` are created on startup if they are missing.
- Verify the release workflow is correctly updated.
