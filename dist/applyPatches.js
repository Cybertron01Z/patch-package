"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyPatch = exports.applyPatchesForPackage = exports.applyPatchesForApp = void 0;
const chalk_1 = __importDefault(require("chalk"));
const fs_1 = require("fs");
const fs_extra_1 = require("fs-extra");
const path_1 = require("path");
const semver_1 = __importDefault(require("semver"));
const hash_1 = require("./hash");
const makePatch_1 = require("./makePatch");
const packageIsDevDependency_1 = require("./packageIsDevDependency");
const apply_1 = require("./patch/apply");
const read_1 = require("./patch/read");
const reverse_1 = require("./patch/reverse");
const patchFs_1 = require("./patchFs");
const path_2 = require("./path");
const stateFile_1 = require("./stateFile");
class PatchApplicationError extends Error {
    constructor(msg) {
        super(msg);
    }
}
function getInstalledPackageVersion({ appPath, path, pathSpecifier, isDevOnly, patchFilename, }) {
    const packageDir = path_2.join(appPath, path);
    if (!fs_extra_1.existsSync(packageDir)) {
        if (process.env.NODE_ENV === "production" && isDevOnly) {
            return null;
        }
        let err = `${chalk_1.default.red("Error:")} Patch file found for package ${path_1.posix.basename(pathSpecifier)}` + ` which is not present at ${path_2.relative(".", packageDir)}`;
        if (!isDevOnly && process.env.NODE_ENV === "production") {
            err += `

  If this package is a dev dependency, rename the patch file to
  
    ${chalk_1.default.bold(patchFilename.replace(".patch", ".dev.patch"))}
`;
        }
        throw new PatchApplicationError(err);
    }
    const { version } = require(path_2.join(packageDir, "package.json"));
    // normalize version for `npm ci`
    const result = semver_1.default.valid(version);
    if (result === null) {
        throw new PatchApplicationError(`${chalk_1.default.red("Error:")} Version string '${version}' cannot be parsed from ${path_2.join(packageDir, "package.json")}`);
    }
    return result;
}
function logPatchApplication(patchDetails) {
    const sequenceString = patchDetails.sequenceNumber != null
        ? ` (${patchDetails.sequenceNumber}${patchDetails.sequenceName ? " " + patchDetails.sequenceName : ""})`
        : "";
    console.log(`${chalk_1.default.bold(patchDetails.pathSpecifier)}@${patchDetails.version}${sequenceString} ${chalk_1.default.green("✔")}`);
}
function applyPatchesForApp({ appPath, reverse, patchDir, shouldExitWithError, shouldExitWithWarning, bestEffort, }) {
    const patchesDirectory = path_2.join(appPath, patchDir);
    const groupedPatches = patchFs_1.getGroupedPatches(patchesDirectory);
    if (groupedPatches.numPatchFiles === 0) {
        console.log(chalk_1.default.blueBright("No patch files found"));
        return;
    }
    const errors = [];
    const warnings = [...groupedPatches.warnings];
    for (const patches of Object.values(groupedPatches.pathSpecifierToPatchFiles)) {
        applyPatchesForPackage({
            patches,
            appPath,
            patchDir,
            reverse,
            warnings,
            errors,
            bestEffort,
        });
    }
    for (const warning of warnings) {
        console.log(warning);
    }
    for (const error of errors) {
        console.log(error);
    }
    const problemsSummary = [];
    if (warnings.length) {
        problemsSummary.push(chalk_1.default.yellow(`${warnings.length} warning(s)`));
    }
    if (errors.length) {
        problemsSummary.push(chalk_1.default.red(`${errors.length} error(s)`));
    }
    if (problemsSummary.length) {
        console.log("---");
        console.log("patch-package finished with", problemsSummary.join(", ") + ".");
    }
    if (errors.length && shouldExitWithError) {
        process.exit(1);
    }
    if (warnings.length && shouldExitWithWarning) {
        process.exit(1);
    }
    process.exit(0);
}
exports.applyPatchesForApp = applyPatchesForApp;
function applyPatchesForPackage({ patches, appPath, patchDir, reverse, warnings, errors, bestEffort, }) {
    const pathSpecifier = patches[0].pathSpecifier;
    const state = patches.length > 1 ? stateFile_1.getPatchApplicationState(patches[0]) : null;
    const unappliedPatches = patches.slice(0);
    const appliedPatches = [];
    // if there are multiple patches to apply, we can't rely on the reverse-patch-dry-run behavior to make this operation
    // idempotent, so instead we need to check the state file to see whether we have already applied any of the patches
    // todo: once this is battle tested we might want to use the same approach for single patches as well, but it's not biggie since the dry run thing is fast
    if (unappliedPatches && state) {
        for (let i = 0; i < state.patches.length; i++) {
            const patchThatWasApplied = state.patches[i];
            if (!patchThatWasApplied.didApply) {
                break;
            }
            const patchToApply = unappliedPatches[0];
            const currentPatchHash = hash_1.hashFile(path_2.join(appPath, patchDir, patchToApply.patchFilename));
            if (patchThatWasApplied.patchContentHash === currentPatchHash) {
                // this patch was applied we can skip it
                appliedPatches.push(unappliedPatches.shift());
            }
            else {
                console.log(chalk_1.default.red("Error:"), `The patches for ${chalk_1.default.bold(pathSpecifier)} have changed.`, `You should reinstall your node_modules folder to make sure the package is up to date`);
                process.exit(1);
            }
        }
    }
    if (reverse && state) {
        // if we are reversing the patches we need to make the unappliedPatches array
        // be the reversed version of the appliedPatches array.
        // The applied patches array should then be empty because it is used differently
        // when outputting the state file.
        unappliedPatches.length = 0;
        unappliedPatches.push(...appliedPatches);
        unappliedPatches.reverse();
        appliedPatches.length = 0;
    }
    if (appliedPatches.length) {
        // some patches have already been applied
        appliedPatches.forEach(logPatchApplication);
    }
    if (!unappliedPatches.length) {
        return;
    }
    let failedPatch = null;
    packageLoop: for (const patchDetails of unappliedPatches) {
        try {
            const { name, version, path, isDevOnly, patchFilename } = patchDetails;
            const installedPackageVersion = getInstalledPackageVersion({
                appPath,
                path,
                pathSpecifier,
                isDevOnly: isDevOnly ||
                    // check for direct-dependents in prod
                    (process.env.NODE_ENV === "production" &&
                        packageIsDevDependency_1.packageIsDevDependency({
                            appPath,
                            patchDetails,
                        })),
                patchFilename,
            });
            if (!installedPackageVersion) {
                // it's ok we're in production mode and this is a dev only package
                console.log(`Skipping dev-only ${chalk_1.default.bold(pathSpecifier)}@${version} ${chalk_1.default.blue("✔")}`);
                continue;
            }
            if (applyPatch({
                patchFilePath: path_2.join(appPath, patchDir, patchFilename),
                reverse,
                patchDetails,
                patchDir,
                cwd: process.cwd(),
                bestEffort,
            })) {
                appliedPatches.push(patchDetails);
                // yay patch was applied successfully
                // print warning if version mismatch
                if (installedPackageVersion !== version) {
                    warnings.push(createVersionMismatchWarning({
                        packageName: name,
                        actualVersion: installedPackageVersion,
                        originalVersion: version,
                        pathSpecifier,
                        path,
                    }));
                }
                logPatchApplication(patchDetails);
            }
            else if (patches.length > 1) {
                makePatch_1.logPatchSequenceError({ patchDetails });
                // in case the package has multiple patches, we need to break out of this inner loop
                // because we don't want to apply more patches on top of the broken state
                failedPatch = patchDetails;
                break packageLoop;
            }
            else if (installedPackageVersion === version) {
                // completely failed to apply patch
                // TODO: propagate useful error messages from patch application
                errors.push(createBrokenPatchFileError({
                    packageName: name,
                    patchFilename,
                    pathSpecifier,
                    path,
                }));
                break packageLoop;
            }
            else {
                errors.push(createPatchApplicationFailureError({
                    packageName: name,
                    actualVersion: installedPackageVersion,
                    originalVersion: version,
                    patchFilename,
                    path,
                    pathSpecifier,
                }));
                // in case the package has multiple patches, we need to break out of this inner loop
                // because we don't want to apply more patches on top of the broken state
                break packageLoop;
            }
        }
        catch (error) {
            if (error instanceof PatchApplicationError) {
                errors.push(error.message);
            }
            else {
                errors.push(createUnexpectedError({
                    filename: patchDetails.patchFilename,
                    error: error,
                }));
            }
            // in case the package has multiple patches, we need to break out of this inner loop
            // because we don't want to apply more patches on top of the broken state
            break packageLoop;
        }
    }
    if (patches.length > 1) {
        if (reverse) {
            if (!state) {
                throw new Error("unexpected state: no state file found while reversing");
            }
            // if we removed all the patches that were previously applied we can delete the state file
            if (appliedPatches.length === patches.length) {
                stateFile_1.clearPatchApplicationState(patches[0]);
            }
            else {
                // We failed while reversing patches and some are still in the applied state.
                // We need to update the state file to reflect that.
                // appliedPatches is currently the patches that were successfully reversed, in the order they were reversed
                // So we need to find the index of the last reversed patch in the original patches array
                // and then remove all the patches after that. Sorry for the confusing code.
                const lastReversedPatchIndex = patches.indexOf(appliedPatches[appliedPatches.length - 1]);
                if (lastReversedPatchIndex === -1) {
                    throw new Error("unexpected state: failed to find last reversed patch in original patches array");
                }
                stateFile_1.savePatchApplicationState({
                    packageDetails: patches[0],
                    patches: patches.slice(0, lastReversedPatchIndex).map((patch) => ({
                        didApply: true,
                        patchContentHash: hash_1.hashFile(path_2.join(appPath, patchDir, patch.patchFilename)),
                        patchFilename: patch.patchFilename,
                    })),
                    isRebasing: false,
                });
            }
        }
        else {
            const nextState = appliedPatches.map((patch) => ({
                didApply: true,
                patchContentHash: hash_1.hashFile(path_2.join(appPath, patchDir, patch.patchFilename)),
                patchFilename: patch.patchFilename,
            }));
            if (failedPatch) {
                nextState.push({
                    didApply: false,
                    patchContentHash: hash_1.hashFile(path_2.join(appPath, patchDir, failedPatch.patchFilename)),
                    patchFilename: failedPatch.patchFilename,
                });
            }
            stateFile_1.savePatchApplicationState({
                packageDetails: patches[0],
                patches: nextState,
                isRebasing: !!failedPatch,
            });
        }
        if (failedPatch) {
            process.exit(1);
        }
    }
}
exports.applyPatchesForPackage = applyPatchesForPackage;
function applyPatch({ patchFilePath, reverse, patchDetails, patchDir, cwd, bestEffort, }) {
    const patch = read_1.readPatch({
        patchFilePath,
        patchDetails,
        patchDir,
    });
    const forward = reverse ? reverse_1.reversePatch(patch) : patch;
    try {
        if (!bestEffort) {
            apply_1.executeEffects(forward, { dryRun: true, cwd, bestEffort: false });
        }
        const errors = bestEffort ? [] : undefined;
        apply_1.executeEffects(forward, { dryRun: false, cwd, bestEffort, errors });
        if (errors === null || errors === void 0 ? void 0 : errors.length) {
            console.log("Saving errors to", chalk_1.default.cyan.bold("./patch-package-errors.log"));
            fs_1.writeFileSync("patch-package-errors.log", errors.join("\n\n"));
            process.exit(0);
        }
    }
    catch (e) {
        console.log(e);
        try {
            const backward = reverse ? patch : reverse_1.reversePatch(patch);
            apply_1.executeEffects(backward, {
                dryRun: true,
                cwd,
                bestEffort: false,
            });
        }
        catch (e) {
            console.log(e);
            return false;
        }
    }
    return true;
}
exports.applyPatch = applyPatch;
function createVersionMismatchWarning({ packageName, actualVersion, originalVersion, pathSpecifier, path, }) {
    return `
${chalk_1.default.yellow("Warning:")} patch-package detected a patch file version mismatch

  Don't worry! This is probably fine. The patch was still applied
  successfully. Here's the deets:

  Patch file created for

    ${packageName}@${chalk_1.default.bold(originalVersion)}

  applied to

    ${packageName}@${chalk_1.default.bold(actualVersion)}
  
  At path
  
    ${path}

  This warning is just to give you a heads-up. There is a small chance of
  breakage even though the patch was applied successfully. Make sure the package
  still behaves like you expect (you wrote tests, right?) and then run

    ${chalk_1.default.bold(`patch-package ${pathSpecifier}`)}

  to update the version in the patch file name and make this warning go away.
`;
}
function createBrokenPatchFileError({ packageName, patchFilename, path, pathSpecifier, }) {
    return `
${chalk_1.default.red.bold("**ERROR**")} ${chalk_1.default.red(`Failed to apply patch for package ${chalk_1.default.bold(packageName)} at path`)}
  
    ${path}

  This error was caused because patch-package cannot apply the following patch file:

    patches/${patchFilename}

  Try removing node_modules and trying again. If that doesn't work, maybe there was
  an accidental change made to the patch file? Try recreating it by manually
  editing the appropriate files and running:
  
    patch-package ${pathSpecifier}
  
  If that doesn't work, then it's a bug in patch-package, so please submit a bug
  report. Thanks!

    https://github.com/ds300/patch-package/issues
    
`;
}
function createPatchApplicationFailureError({ packageName, actualVersion, originalVersion, patchFilename, path, pathSpecifier, }) {
    return `
${chalk_1.default.red.bold("**ERROR**")} ${chalk_1.default.red(`Failed to apply patch for package ${chalk_1.default.bold(packageName)} at path`)}
  
    ${path}

  This error was caused because ${chalk_1.default.bold(packageName)} has changed since you
  made the patch file for it. This introduced conflicts with your patch,
  just like a merge conflict in Git when separate incompatible changes are
  made to the same piece of code.

  Maybe this means your patch file is no longer necessary, in which case
  hooray! Just delete it!

  Otherwise, you need to generate a new patch file.

  To generate a new one, just repeat the steps you made to generate the first
  one.

  i.e. manually make the appropriate file changes, then run 

    patch-package ${pathSpecifier}

  Info:
    Patch file: patches/${patchFilename}
    Patch was made for version: ${chalk_1.default.green.bold(originalVersion)}
    Installed version: ${chalk_1.default.red.bold(actualVersion)}
`;
}
function createUnexpectedError({ filename, error, }) {
    return `
${chalk_1.default.red.bold("**ERROR**")} ${chalk_1.default.red(`Failed to apply patch file ${chalk_1.default.bold(filename)}`)}
  
${error.stack}

  `;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbHlQYXRjaGVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2FwcGx5UGF0Y2hlcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxrREFBeUI7QUFDekIsMkJBQWtDO0FBQ2xDLHVDQUFxQztBQUNyQywrQkFBNEI7QUFDNUIsb0RBQTJCO0FBQzNCLGlDQUFpQztBQUNqQywyQ0FBbUQ7QUFFbkQscUVBQWlFO0FBQ2pFLHlDQUE4QztBQUM5Qyx1Q0FBd0M7QUFDeEMsNkNBQThDO0FBQzlDLHVDQUE2QztBQUM3QyxpQ0FBdUM7QUFDdkMsMkNBS29CO0FBRXBCLE1BQU0scUJBQXNCLFNBQVEsS0FBSztJQUN2QyxZQUFZLEdBQVc7UUFDckIsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO0lBQ1osQ0FBQztDQUNGO0FBRUQsU0FBUywwQkFBMEIsQ0FBQyxFQUNsQyxPQUFPLEVBQ1AsSUFBSSxFQUNKLGFBQWEsRUFDYixTQUFTLEVBQ1QsYUFBYSxHQU9kO0lBQ0MsTUFBTSxVQUFVLEdBQUcsV0FBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQTtJQUN0QyxJQUFJLENBQUMscUJBQVUsQ0FBQyxVQUFVLENBQUMsRUFBRTtRQUMzQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxLQUFLLFlBQVksSUFBSSxTQUFTLEVBQUU7WUFDdEQsT0FBTyxJQUFJLENBQUE7U0FDWjtRQUVELElBQUksR0FBRyxHQUNMLEdBQUcsZUFBSyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsaUNBQWlDLFlBQUssQ0FBQyxRQUFRLENBQ25FLGFBQWEsQ0FDZCxFQUFFLEdBQUcsNEJBQTRCLGVBQVEsQ0FBQyxHQUFHLEVBQUUsVUFBVSxDQUFDLEVBQUUsQ0FBQTtRQUUvRCxJQUFJLENBQUMsU0FBUyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxLQUFLLFlBQVksRUFBRTtZQUN2RCxHQUFHLElBQUk7Ozs7TUFJUCxlQUFLLENB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Y0FJSSxhQUFhOzs7Ozs7b0JBTVAsYUFBYTs7Ozs7OztDQU9oQyxDQUFBO0FBQ0QsQ0FBQztBQUVELFNBQVMsa0NBQWtDLENBQUMsRUFDMUMsV0FBVyxFQUNYLGFBQWEsRUFDYixlQUFlLEVBQ2YsYUFBYSxFQUNiLElBQUksRUFDSixhQUFhLEdBUWQ7SUFDQyxPQUFPO0VBQ1AsZUFBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksZUFBSyxDQUFDLEdBQUcsQ0FDdEMscUNBQXFDLGVBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FDdkU7O01BRUcsSUFBSTs7a0NBRXdCLGVBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7b0JBZXJDLGFBQWE7OzswQkFHUCxhQUFhO2tDQUNMLGVBQUssQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQzt5QkFDMUMsZUFBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDO0NBQ3JELENBQUE7QUFDRCxDQUFDO0FBRUQsU0FBUyxxQkFBcUIsQ0FBQyxFQUM3QixRQUFRLEVBQ1IsS0FBSyxHQUlOO0lBQ0MsT0FBTztFQUNQLGVBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLGVBQUssQ0FBQyxHQUFHLENBQ3RDLDhCQUE4QixlQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQ3JEOztFQUVELEtBQUssQ0FBQyxLQUFLOztHQUVWLENBQUE7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGNoYWxrIGZyb20gXCJjaGFsa1wiXG5pbXBvcnQgeyB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcImZzXCJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwiZnMtZXh0cmFcIlxuaW1wb3J0IHsgcG9zaXggfSBmcm9tIFwicGF0aFwiXG5pbXBvcnQgc2VtdmVyIGZyb20gXCJzZW12ZXJcIlxuaW1wb3J0IHsgaGFzaEZpbGUgfSBmcm9tIFwiLi9oYXNoXCJcbmltcG9ydCB7IGxvZ1BhdGNoU2VxdWVuY2VFcnJvciB9IGZyb20gXCIuL21ha2VQYXRjaFwiXG5pbXBvcnQgeyBQYWNrYWdlRGV0YWlscywgUGF0Y2hlZFBhY2thZ2VEZXRhaWxzIH0gZnJvbSBcIi4vUGFja2FnZURldGFpbHNcIlxuaW1wb3J0IHsgcGFja2FnZUlzRGV2RGVwZW5kZW5jeSB9IGZyb20gXCIuL3BhY2thZ2VJc0RldkRlcGVuZGVuY3lcIlxuaW1wb3J0IHsgZXhlY3V0ZUVmZmVjdHMgfSBmcm9tIFwiLi9wYXRjaC9hcHBseVwiXG5pbXBvcnQgeyByZWFkUGF0Y2ggfSBmcm9tIFwiLi9wYXRjaC9yZWFkXCJcbmltcG9ydCB7IHJldmVyc2VQYXRjaCB9IGZyb20gXCIuL3BhdGNoL3JldmVyc2VcIlxuaW1wb3J0IHsgZ2V0R3JvdXBlZFBhdGNoZXMgfSBmcm9tIFwiLi9wYXRjaEZzXCJcbmltcG9ydCB7IGpvaW4sIHJlbGF0aXZlIH0gZnJvbSBcIi4vcGF0aFwiXG5pbXBvcnQge1xuICBjbGVhclBhdGNoQXBwbGljYXRpb25TdGF0ZSxcbiAgZ2V0UGF0Y2hBcHBsaWNhdGlvblN0YXRlLFxuICBQYXRjaFN0YXRlLFxuICBzYXZlUGF0Y2hBcHBsaWNhdGlvblN0YXRlLFxufSBmcm9tIFwiLi9zdGF0ZUZpbGVcIlxuXG5jbGFzcyBQYXRjaEFwcGxpY2F0aW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1zZzogc3RyaW5nKSB7XG4gICAgc3VwZXIobXNnKVxuICB9XG59XG5cbmZ1bmN0aW9uIGdldEluc3RhbGxlZFBhY2thZ2VWZXJzaW9uKHtcbiAgYXBwUGF0aCxcbiAgcGF0aCxcbiAgcGF0aFNwZWNpZmllcixcbiAgaXNEZXZPbmx5LFxuICBwYXRjaEZpbGVuYW1lLFxufToge1xuICBhcHBQYXRoOiBzdHJpbmdcbiAgcGF0aDogc3RyaW5nXG4gIHBhdGhTcGVjaWZpZXI6IHN0cmluZ1xuICBpc0Rldk9ubHk6IGJvb2xlYW5cbiAgcGF0Y2hGaWxlbmFtZTogc3RyaW5nXG59KTogbnVsbCB8IHN0cmluZyB7XG4gIGNvbnN0IHBhY2thZ2VEaXIgPSBqb2luKGFwcFBhdGgsIHBhdGgpXG4gIGlmICghZXhpc3RzU3luYyhwYWNrYWdlRGlyKSkge1xuICAgIGlmIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gXCJwcm9kdWN0aW9uXCIgJiYgaXNEZXZPbmx5KSB7XG4gICAgICByZXR1cm4gbnVsbFxuICAgIH1cblxuICAgIGxldCBlcnIgPVxuICAgICAgYCR7Y2hhbGsucmVkKFwiRXJyb3I6XCIpfSBQYXRjaCBmaWxlIGZvdW5kIGZvciBwYWNrYWdlICR7cG9zaXguYmFzZW5hbWUoXG4gICAgICAgIHBhdGhTcGVjaWZpZXIsXG4gICAgICApfWAgKyBgIHdoaWNoIGlzIG5vdCBwcmVzZW50IGF0ICR7cmVsYXRpdmUoXCIuXCIsIHBhY2thZ2VEaXIpfWBcblxuICAgIGlmICghaXNEZXZPbmx5ICYmIHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIikge1xuICAgICAgZXJyICs9IGBcblxuICBJZiB0aGlzIHBhY2thZ2UgaXMgYSBkZXYgZGVwZW5kZW5jeSwgcmVuYW1lIHRoZSBwYXRjaCBmaWxlIHRvXG4gIFxuICAgICR7Y2hhbGsuYm9sZChwYXRjaEZpbGVuYW1lLnJlcGxhY2UoXCIucGF0Y2hcIiwgXCIuZGV2LnBhdGNoXCIpKX1cbmBcbiAgICB9XG4gICAgdGhyb3cgbmV3IFBhdGNoQXBwbGljYXRpb25FcnJvcihlcnIpXG4gIH1cblxuICBjb25zdCB7IHZlcnNpb24gfSA9IHJlcXVpcmUoam9pbihwYWNrYWdlRGlyLCBcInBhY2thZ2UuanNvblwiKSlcbiAgLy8gbm9ybWFsaXplIHZlcnNpb24gZm9yIGBucG0gY2lgXG4gIGNvbnN0IHJlc3VsdCA9IHNlbXZlci52YWxpZCh2ZXJzaW9uKVxuICBpZiAocmVzdWx0ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IFBhdGNoQXBwbGljYXRpb25FcnJvcihcbiAgICAgIGAke2NoYWxrLnJlZChcbiAgICAgICAgXCJFcnJvcjpcIixcbiAgICAgICl9IFZlcnNpb24gc3RyaW5nICcke3ZlcnNpb259JyBjYW5ub3QgYmUgcGFyc2VkIGZyb20gJHtqb2luKFxuICAgICAgICBwYWNrYWdlRGlyLFxuICAgICAgICBcInBhY2thZ2UuanNvblwiLFxuICAgICAgKX1gLFxuICAgIClcbiAgfVxuXG4gIHJldHVybiByZXN1bHQgYXMgc3RyaW5nXG59XG5cbmZ1bmN0aW9uIGxvZ1BhdGNoQXBwbGljYXRpb24ocGF0Y2hEZXRhaWxzOiBQYXRjaGVkUGFja2FnZURldGFpbHMpIHtcbiAgY29uc3Qgc2VxdWVuY2VTdHJpbmcgPVxuICAgIHBhdGNoRGV0YWlscy5zZXF1ZW5jZU51bWJlciAhPSBudWxsXG4gICAgICA/IGAgKCR7cGF0Y2hEZXRhaWxzLnNlcXVlbmNlTnVtYmVyfSR7XG4gICAgICAgICAgcGF0Y2hEZXRhaWxzLnNlcXVlbmNlTmFtZSA/IFwiIFwiICsgcGF0Y2hEZXRhaWxzLnNlcXVlbmNlTmFtZSA6IFwiXCJcbiAgICAgICAgfSlgXG4gICAgICA6IFwiXCJcbiAgY29uc29sZS5sb2coXG4gICAgYCR7Y2hhbGsuYm9sZChwYXRjaERldGFpbHMucGF0aFNwZWNpZmllcil9QCR7XG4gICAgICBwYXRjaERldGFpbHMudmVyc2lvblxuICAgIH0ke3NlcXVlbmNlU3RyaW5nfSAke2NoYWxrLmdyZWVuKFwi4pyUXCIpfWAsXG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGF0Y2hlc0ZvckFwcCh7XG4gIGFwcFBhdGgsXG4gIHJldmVyc2UsXG4gIHBhdGNoRGlyLFxuICBzaG91bGRFeGl0V2l0aEVycm9yLFxuICBzaG91bGRFeGl0V2l0aFdhcm5pbmcsXG4gIGJlc3RFZmZvcnQsXG59OiB7XG4gIGFwcFBhdGg6IHN0cmluZ1xuICByZXZlcnNlOiBib29sZWFuXG4gIHBhdGNoRGlyOiBzdHJpbmdcbiAgc2hvdWxkRXhpdFdpdGhFcnJvcjogYm9vbGVhblxuICBzaG91bGRFeGl0V2l0aFdhcm5pbmc6IGJvb2xlYW5cbiAgYmVzdEVmZm9ydDogYm9vbGVhblxufSk6IHZvaWQge1xuICBjb25zdCBwYXRjaGVzRGlyZWN0b3J5ID0gam9pbihhcHBQYXRoLCBwYXRjaERpcilcbiAgY29uc3QgZ3JvdXBlZFBhdGNoZXMgPSBnZXRHcm91cGVkUGF0Y2hlcyhwYXRjaGVzRGlyZWN0b3J5KVxuXG4gIGlmIChncm91cGVkUGF0Y2hlcy5udW1QYXRjaEZpbGVzID09PSAwKSB7XG4gICAgY29uc29sZS5sb2coY2hhbGsuYmx1ZUJyaWdodChcIk5vIHBhdGNoIGZpbGVzIGZvdW5kXCIpKVxuICAgIHJldHVyblxuICB9XG5cbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdXG4gIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFsuLi5ncm91cGVkUGF0Y2hlcy53YXJuaW5nc11cblxuICBmb3IgKGNvbnN0IHBhdGNoZXMgb2YgT2JqZWN0LnZhbHVlcyhcbiAgICBncm91cGVkUGF0Y2hlcy5wYXRoU3BlY2lmaWVyVG9QYXRjaEZpbGVzLFxuICApKSB7XG4gICAgYXBwbHlQYXRjaGVzRm9yUGFja2FnZSh7XG4gICAgICBwYXRjaGVzLFxuICAgICAgYXBwUGF0aCxcbiAgICAgIHBhdGNoRGlyLFxuICAgICAgcmV2ZXJzZSxcbiAgICAgIHdhcm5pbmdzLFxuICAgICAgZXJyb3JzLFxuICAgICAgYmVzdEVmZm9ydCxcbiAgICB9KVxuICB9XG5cbiAgZm9yIChjb25zdCB3YXJuaW5nIG9mIHdhcm5pbmdzKSB7XG4gICAgY29uc29sZS5sb2cod2FybmluZylcbiAgfVxuICBmb3IgKGNvbnN0IGVycm9yIG9mIGVycm9ycykge1xuICAgIGNvbnNvbGUubG9nKGVycm9yKVxuICB9XG5cbiAgY29uc3QgcHJvYmxlbXNTdW1tYXJ5ID0gW11cbiAgaWYgKHdhcm5pbmdzLmxlbmd0aCkge1xuICAgIHByb2JsZW1zU3VtbWFyeS5wdXNoKGNoYWxrLnllbGxvdyhgJHt3YXJuaW5ncy5sZW5ndGh9IHdhcm5pbmcocylgKSlcbiAgfVxuICBpZiAoZXJyb3JzLmxlbmd0aCkge1xuICAgIHByb2JsZW1zU3VtbWFyeS5wdXNoKGNoYWxrLnJlZChgJHtlcnJvcnMubGVuZ3RofSBlcnJvcihzKWApKVxuICB9XG5cbiAgaWYgKHByb2JsZW1zU3VtbWFyeS5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmxvZyhcIi0tLVwiKVxuICAgIGNvbnNvbGUubG9nKFwicGF0Y2gtcGFja2FnZSBmaW5pc2hlZCB3aXRoXCIsIHByb2JsZW1zU3VtbWFyeS5qb2luKFwiLCBcIikgKyBcIi5cIilcbiAgfVxuXG4gIGlmIChlcnJvcnMubGVuZ3RoICYmIHNob3VsZEV4aXRXaXRoRXJyb3IpIHtcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGlmICh3YXJuaW5ncy5sZW5ndGggJiYgc2hvdWxkRXhpdFdpdGhXYXJuaW5nKSB7XG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBwcm9jZXNzLmV4aXQoMClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGF0Y2hlc0ZvclBhY2thZ2Uoe1xuICBwYXRjaGVzLFxuICBhcHBQYXRoLFxuICBwYXRjaERpcixcbiAgcmV2ZXJzZSxcbiAgd2FybmluZ3MsXG4gIGVycm9ycyxcbiAgYmVzdEVmZm9ydCxcbn06IHtcbiAgcGF0Y2hlczogUGF0Y2hlZFBhY2thZ2VEZXRhaWxzW11cbiAgYXBwUGF0aDogc3RyaW5nXG4gIHBhdGNoRGlyOiBzdHJpbmdcbiAgcmV2ZXJzZTogYm9vbGVhblxuICB3YXJuaW5nczogc3RyaW5nW11cbiAgZXJyb3JzOiBzdHJpbmdbXVxuICBiZXN0RWZmb3J0OiBib29sZWFuXG59KSB7XG4gIGNvbnN0IHBhdGhTcGVjaWZpZXIgPSBwYXRjaGVzWzBdLnBhdGhTcGVjaWZpZXJcbiAgY29uc3Qgc3RhdGUgPSBwYXRjaGVzLmxlbmd0aCA+IDEgPyBnZXRQYXRjaEFwcGxpY2F0aW9uU3RhdGUocGF0Y2hlc1swXSkgOiBudWxsXG4gIGNvbnN0IHVuYXBwbGllZFBhdGNoZXMgPSBwYXRjaGVzLnNsaWNlKDApXG4gIGNvbnN0IGFwcGxpZWRQYXRjaGVzOiBQYXRjaGVkUGFja2FnZURldGFpbHNbXSA9IFtdXG4gIC8vIGlmIHRoZXJlIGFyZSBtdWx0aXBsZSBwYXRjaGVzIHRvIGFwcGx5LCB3ZSBjYW4ndCByZWx5IG9uIHRoZSByZXZlcnNlLXBhdGNoLWRyeS1ydW4gYmVoYXZpb3IgdG8gbWFrZSB0aGlzIG9wZXJhdGlvblxuICAvLyBpZGVtcG90ZW50LCBzbyBpbnN0ZWFkIHdlIG5lZWQgdG8gY2hlY2sgdGhlIHN0YXRlIGZpbGUgdG8gc2VlIHdoZXRoZXIgd2UgaGF2ZSBhbHJlYWR5IGFwcGxpZWQgYW55IG9mIHRoZSBwYXRjaGVzXG4gIC8vIHRvZG86IG9uY2UgdGhpcyBpcyBiYXR0bGUgdGVzdGVkIHdlIG1pZ2h0IHdhbnQgdG8gdXNlIHRoZSBzYW1lIGFwcHJvYWNoIGZvciBzaW5nbGUgcGF0Y2hlcyBhcyB3ZWxsLCBidXQgaXQncyBub3QgYmlnZ2llIHNpbmNlIHRoZSBkcnkgcnVuIHRoaW5nIGlzIGZhc3RcbiAgaWYgKHVuYXBwbGllZFBhdGNoZXMgJiYgc3RhdGUpIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHN0YXRlLnBhdGNoZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHBhdGNoVGhhdFdhc0FwcGxpZWQgPSBzdGF0ZS5wYXRjaGVzW2ldXG4gICAgICBpZiAoIXBhdGNoVGhhdFdhc0FwcGxpZWQuZGlkQXBwbHkpIHtcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhdGNoVG9BcHBseSA9IHVuYXBwbGllZFBhdGNoZXNbMF1cbiAgICAgIGNvbnN0IGN1cnJlbnRQYXRjaEhhc2ggPSBoYXNoRmlsZShcbiAgICAgICAgam9pbihhcHBQYXRoLCBwYXRjaERpciwgcGF0Y2hUb0FwcGx5LnBhdGNoRmlsZW5hbWUpLFxuICAgICAgKVxuICAgICAgaWYgKHBhdGNoVGhhdFdhc0FwcGxpZWQucGF0Y2hDb250ZW50SGFzaCA9PT0gY3VycmVudFBhdGNoSGFzaCkge1xuICAgICAgICAvLyB0aGlzIHBhdGNoIHdhcyBhcHBsaWVkIHdlIGNhbiBza2lwIGl0XG4gICAgICAgIGFwcGxpZWRQYXRjaGVzLnB1c2godW5hcHBsaWVkUGF0Y2hlcy5zaGlmdCgpISlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgIGNoYWxrLnJlZChcIkVycm9yOlwiKSxcbiAgICAgICAgICBgVGhlIHBhdGNoZXMgZm9yICR7Y2hhbGsuYm9sZChwYXRoU3BlY2lmaWVyKX0gaGF2ZSBjaGFuZ2VkLmAsXG4gICAgICAgICAgYFlvdSBzaG91bGQgcmVpbnN0YWxsIHlvdXIgbm9kZV9tb2R1bGVzIGZvbGRlciB0byBtYWtlIHN1cmUgdGhlIHBhY2thZ2UgaXMgdXAgdG8gZGF0ZWAsXG4gICAgICAgIClcbiAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHJldmVyc2UgJiYgc3RhdGUpIHtcbiAgICAvLyBpZiB3ZSBhcmUgcmV2ZXJzaW5nIHRoZSBwYXRjaGVzIHdlIG5lZWQgdG8gbWFrZSB0aGUgdW5hcHBsaWVkUGF0Y2hlcyBhcnJheVxuICAgIC8vIGJlIHRoZSByZXZlcnNlZCB2ZXJzaW9uIG9mIHRoZSBhcHBsaWVkUGF0Y2hlcyBhcnJheS5cbiAgICAvLyBUaGUgYXBwbGllZCBwYXRjaGVzIGFycmF5IHNob3VsZCB0aGVuIGJlIGVtcHR5IGJlY2F1c2UgaXQgaXMgdXNlZCBkaWZmZXJlbnRseVxuICAgIC8vIHdoZW4gb3V0cHV0dGluZyB0aGUgc3RhdGUgZmlsZS5cbiAgICB1bmFwcGxpZWRQYXRjaGVzLmxlbmd0aCA9IDBcbiAgICB1bmFwcGxpZWRQYXRjaGVzLnB1c2goLi4uYXBwbGllZFBhdGNoZXMpXG4gICAgdW5hcHBsaWVkUGF0Y2hlcy5yZXZlcnNlKClcbiAgICBhcHBsaWVkUGF0Y2hlcy5sZW5ndGggPSAwXG4gIH1cbiAgaWYgKGFwcGxpZWRQYXRjaGVzLmxlbmd0aCkge1xuICAgIC8vIHNvbWUgcGF0Y2hlcyBoYXZlIGFscmVhZHkgYmVlbiBhcHBsaWVkXG4gICAgYXBwbGllZFBhdGNoZXMuZm9yRWFjaChsb2dQYXRjaEFwcGxpY2F0aW9uKVxuICB9XG4gIGlmICghdW5hcHBsaWVkUGF0Y2hlcy5sZW5ndGgpIHtcbiAgICByZXR1cm5cbiAgfVxuICBsZXQgZmFpbGVkUGF0Y2g6IFBhdGNoZWRQYWNrYWdlRGV0YWlscyB8IG51bGwgPSBudWxsXG4gIHBhY2thZ2VMb29wOiBmb3IgKGNvbnN0IHBhdGNoRGV0YWlscyBvZiB1bmFwcGxpZWRQYXRjaGVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgbmFtZSwgdmVyc2lvbiwgcGF0aCwgaXNEZXZPbmx5LCBwYXRjaEZpbGVuYW1lIH0gPSBwYXRjaERldGFpbHNcblxuICAgICAgY29uc3QgaW5zdGFsbGVkUGFja2FnZVZlcnNpb24gPSBnZXRJbnN0YWxsZWRQYWNrYWdlVmVyc2lvbih7XG4gICAgICAgIGFwcFBhdGgsXG4gICAgICAgIHBhdGgsXG4gICAgICAgIHBhdGhTcGVjaWZpZXIsXG4gICAgICAgIGlzRGV2T25seTpcbiAgICAgICAgICBpc0Rldk9ubHkgfHxcbiAgICAgICAgICAvLyBjaGVjayBmb3IgZGlyZWN0LWRlcGVuZGVudHMgaW4gcHJvZFxuICAgICAgICAgIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gXCJwcm9kdWN0aW9uXCIgJiZcbiAgICAgICAgICAgIHBhY2thZ2VJc0RldkRlcGVuZGVuY3koe1xuICAgICAgICAgICAgICBhcHBQYXRoLFxuICAgICAgICAgICAgICBwYXRjaERldGFpbHMsXG4gICAgICAgICAgICB9KSksXG4gICAgICAgIHBhdGNoRmlsZW5hbWUsXG4gICAgICB9KVxuICAgICAgaWYgKCFpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbikge1xuICAgICAgICAvLyBpdCdzIG9rIHdlJ3JlIGluIHByb2R1Y3Rpb24gbW9kZSBhbmQgdGhpcyBpcyBhIGRldiBvbmx5IHBhY2thZ2VcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgYFNraXBwaW5nIGRldi1vbmx5ICR7Y2hhbGsuYm9sZChcbiAgICAgICAgICAgIHBhdGhTcGVjaWZpZXIsXG4gICAgICAgICAgKX1AJHt2ZXJzaW9ufSAke2NoYWxrLmJsdWUoXCLinJRcIil9YCxcbiAgICAgICAgKVxuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuXG4gICAgICBpZiAoXG4gICAgICAgIGFwcGx5UGF0Y2goe1xuICAgICAgICAgIHBhdGNoRmlsZVBhdGg6IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHBhdGNoRmlsZW5hbWUpIGFzIHN0cmluZyxcbiAgICAgICAgICByZXZlcnNlLFxuICAgICAgICAgIHBhdGNoRGV0YWlscyxcbiAgICAgICAgICBwYXRjaERpcixcbiAgICAgICAgICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gICAgICAgICAgYmVzdEVmZm9ydCxcbiAgICAgICAgfSlcbiAgICAgICkge1xuICAgICAgICBhcHBsaWVkUGF0Y2hlcy5wdXNoKHBhdGNoRGV0YWlscylcbiAgICAgICAgLy8geWF5IHBhdGNoIHdhcyBhcHBsaWVkIHN1Y2Nlc3NmdWxseVxuICAgICAgICAvLyBwcmludCB3YXJuaW5nIGlmIHZlcnNpb24gbWlzbWF0Y2hcbiAgICAgICAgaWYgKGluc3RhbGxlZFBhY2thZ2VWZXJzaW9uICE9PSB2ZXJzaW9uKSB7XG4gICAgICAgICAgd2FybmluZ3MucHVzaChcbiAgICAgICAgICAgIGNyZWF0ZVZlcnNpb25NaXNtYXRjaFdhcm5pbmcoe1xuICAgICAgICAgICAgICBwYWNrYWdlTmFtZTogbmFtZSxcbiAgICAgICAgICAgICAgYWN0dWFsVmVyc2lvbjogaW5zdGFsbGVkUGFja2FnZVZlcnNpb24sXG4gICAgICAgICAgICAgIG9yaWdpbmFsVmVyc2lvbjogdmVyc2lvbixcbiAgICAgICAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgICBsb2dQYXRjaEFwcGxpY2F0aW9uKHBhdGNoRGV0YWlscylcbiAgICAgIH0gZWxzZSBpZiAocGF0Y2hlcy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGxvZ1BhdGNoU2VxdWVuY2VFcnJvcih7IHBhdGNoRGV0YWlscyB9KVxuICAgICAgICAvLyBpbiBjYXNlIHRoZSBwYWNrYWdlIGhhcyBtdWx0aXBsZSBwYXRjaGVzLCB3ZSBuZWVkIHRvIGJyZWFrIG91dCBvZiB0aGlzIGlubmVyIGxvb3BcbiAgICAgICAgLy8gYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIGFwcGx5IG1vcmUgcGF0Y2hlcyBvbiB0b3Agb2YgdGhlIGJyb2tlbiBzdGF0ZVxuICAgICAgICBmYWlsZWRQYXRjaCA9IHBhdGNoRGV0YWlsc1xuICAgICAgICBicmVhayBwYWNrYWdlTG9vcFxuICAgICAgfSBlbHNlIGlmIChpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbiA9PT0gdmVyc2lvbikge1xuICAgICAgICAvLyBjb21wbGV0ZWx5IGZhaWxlZCB0byBhcHBseSBwYXRjaFxuICAgICAgICAvLyBUT0RPOiBwcm9wYWdhdGUgdXNlZnVsIGVycm9yIG1lc3NhZ2VzIGZyb20gcGF0Y2ggYXBwbGljYXRpb25cbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgY3JlYXRlQnJva2VuUGF0Y2hGaWxlRXJyb3Ioe1xuICAgICAgICAgICAgcGFja2FnZU5hbWU6IG5hbWUsXG4gICAgICAgICAgICBwYXRjaEZpbGVuYW1lLFxuICAgICAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgfSksXG4gICAgICAgIClcbiAgICAgICAgYnJlYWsgcGFja2FnZUxvb3BcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIGNyZWF0ZVBhdGNoQXBwbGljYXRpb25GYWlsdXJlRXJyb3Ioe1xuICAgICAgICAgICAgcGFja2FnZU5hbWU6IG5hbWUsXG4gICAgICAgICAgICBhY3R1YWxWZXJzaW9uOiBpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbixcbiAgICAgICAgICAgIG9yaWdpbmFsVmVyc2lvbjogdmVyc2lvbixcbiAgICAgICAgICAgIHBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgICB9KSxcbiAgICAgICAgKVxuICAgICAgICAvLyBpbiBjYXNlIHRoZSBwYWNrYWdlIGhhcyBtdWx0aXBsZSBwYXRjaGVzLCB3ZSBuZWVkIHRvIGJyZWFrIG91dCBvZiB0aGlzIGlubmVyIGxvb3BcbiAgICAgICAgLy8gYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIGFwcGx5IG1vcmUgcGF0Y2hlcyBvbiB0b3Agb2YgdGhlIGJyb2tlbiBzdGF0ZVxuICAgICAgICBicmVhayBwYWNrYWdlTG9vcFxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBQYXRjaEFwcGxpY2F0aW9uRXJyb3IpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goZXJyb3IubWVzc2FnZSlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIGNyZWF0ZVVuZXhwZWN0ZWRFcnJvcih7XG4gICAgICAgICAgICBmaWxlbmFtZTogcGF0Y2hEZXRhaWxzLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgICBlcnJvcjogZXJyb3IgYXMgRXJyb3IsXG4gICAgICAgICAgfSksXG4gICAgICAgIClcbiAgICAgIH1cbiAgICAgIC8vIGluIGNhc2UgdGhlIHBhY2thZ2UgaGFzIG11bHRpcGxlIHBhdGNoZXMsIHdlIG5lZWQgdG8gYnJlYWsgb3V0IG9mIHRoaXMgaW5uZXIgbG9vcFxuICAgICAgLy8gYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIGFwcGx5IG1vcmUgcGF0Y2hlcyBvbiB0b3Agb2YgdGhlIGJyb2tlbiBzdGF0ZVxuICAgICAgYnJlYWsgcGFja2FnZUxvb3BcbiAgICB9XG4gIH1cblxuICBpZiAocGF0Y2hlcy5sZW5ndGggPiAxKSB7XG4gICAgaWYgKHJldmVyc2UpIHtcbiAgICAgIGlmICghc3RhdGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidW5leHBlY3RlZCBzdGF0ZTogbm8gc3RhdGUgZmlsZSBmb3VuZCB3aGlsZSByZXZlcnNpbmdcIilcbiAgICAgIH1cbiAgICAgIC8vIGlmIHdlIHJlbW92ZWQgYWxsIHRoZSBwYXRjaGVzIHRoYXQgd2VyZSBwcmV2aW91c2x5IGFwcGxpZWQgd2UgY2FuIGRlbGV0ZSB0aGUgc3RhdGUgZmlsZVxuICAgICAgaWYgKGFwcGxpZWRQYXRjaGVzLmxlbmd0aCA9PT0gcGF0Y2hlcy5sZW5ndGgpIHtcbiAgICAgICAgY2xlYXJQYXRjaEFwcGxpY2F0aW9uU3RhdGUocGF0Y2hlc1swXSlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFdlIGZhaWxlZCB3aGlsZSByZXZlcnNpbmcgcGF0Y2hlcyBhbmQgc29tZSBhcmUgc3RpbGwgaW4gdGhlIGFwcGxpZWQgc3RhdGUuXG4gICAgICAgIC8vIFdlIG5lZWQgdG8gdXBkYXRlIHRoZSBzdGF0ZSBmaWxlIHRvIHJlZmxlY3QgdGhhdC5cbiAgICAgICAgLy8gYXBwbGllZFBhdGNoZXMgaXMgY3VycmVudGx5IHRoZSBwYXRjaGVzIHRoYXQgd2VyZSBzdWNjZXNzZnVsbHkgcmV2ZXJzZWQsIGluIHRoZSBvcmRlciB0aGV5IHdlcmUgcmV2ZXJzZWRcbiAgICAgICAgLy8gU28gd2UgbmVlZCB0byBmaW5kIHRoZSBpbmRleCBvZiB0aGUgbGFzdCByZXZlcnNlZCBwYXRjaCBpbiB0aGUgb3JpZ2luYWwgcGF0Y2hlcyBhcnJheVxuICAgICAgICAvLyBhbmQgdGhlbiByZW1vdmUgYWxsIHRoZSBwYXRjaGVzIGFmdGVyIHRoYXQuIFNvcnJ5IGZvciB0aGUgY29uZnVzaW5nIGNvZGUuXG4gICAgICAgIGNvbnN0IGxhc3RSZXZlcnNlZFBhdGNoSW5kZXggPSBwYXRjaGVzLmluZGV4T2YoXG4gICAgICAgICAgYXBwbGllZFBhdGNoZXNbYXBwbGllZFBhdGNoZXMubGVuZ3RoIC0gMV0sXG4gICAgICAgIClcbiAgICAgICAgaWYgKGxhc3RSZXZlcnNlZFBhdGNoSW5kZXggPT09IC0xKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJ1bmV4cGVjdGVkIHN0YXRlOiBmYWlsZWQgdG8gZmluZCBsYXN0IHJldmVyc2VkIHBhdGNoIGluIG9yaWdpbmFsIHBhdGNoZXMgYXJyYXlcIixcbiAgICAgICAgICApXG4gICAgICAgIH1cblxuICAgICAgICBzYXZlUGF0Y2hBcHBsaWNhdGlvblN0YXRlKHtcbiAgICAgICAgICBwYWNrYWdlRGV0YWlsczogcGF0Y2hlc1swXSxcbiAgICAgICAgICBwYXRjaGVzOiBwYXRjaGVzLnNsaWNlKDAsIGxhc3RSZXZlcnNlZFBhdGNoSW5kZXgpLm1hcCgocGF0Y2gpID0+ICh7XG4gICAgICAgICAgICBkaWRBcHBseTogdHJ1ZSxcbiAgICAgICAgICAgIHBhdGNoQ29udGVudEhhc2g6IGhhc2hGaWxlKFxuICAgICAgICAgICAgICBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwYXRjaC5wYXRjaEZpbGVuYW1lKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBwYXRjaEZpbGVuYW1lOiBwYXRjaC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICBpc1JlYmFzaW5nOiBmYWxzZSxcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgbmV4dFN0YXRlID0gYXBwbGllZFBhdGNoZXMubWFwKFxuICAgICAgICAocGF0Y2gpOiBQYXRjaFN0YXRlID0+ICh7XG4gICAgICAgICAgZGlkQXBwbHk6IHRydWUsXG4gICAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUoXG4gICAgICAgICAgICBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwYXRjaC5wYXRjaEZpbGVuYW1lKSxcbiAgICAgICAgICApLFxuICAgICAgICAgIHBhdGNoRmlsZW5hbWU6IHBhdGNoLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgIH0pLFxuICAgICAgKVxuXG4gICAgICBpZiAoZmFpbGVkUGF0Y2gpIHtcbiAgICAgICAgbmV4dFN0YXRlLnB1c2goe1xuICAgICAgICAgIGRpZEFwcGx5OiBmYWxzZSxcbiAgICAgICAgICBwYXRjaENvbnRlbnRIYXNoOiBoYXNoRmlsZShcbiAgICAgICAgICAgIGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIGZhaWxlZFBhdGNoLnBhdGNoRmlsZW5hbWUpLFxuICAgICAgICAgICksXG4gICAgICAgICAgcGF0Y2hGaWxlbmFtZTogZmFpbGVkUGF0Y2gucGF0Y2hGaWxlbmFtZSxcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICAgIHNhdmVQYXRjaEFwcGxpY2F0aW9uU3RhdGUoe1xuICAgICAgICBwYWNrYWdlRGV0YWlsczogcGF0Y2hlc1swXSxcbiAgICAgICAgcGF0Y2hlczogbmV4dFN0YXRlLFxuICAgICAgICBpc1JlYmFzaW5nOiAhIWZhaWxlZFBhdGNoLFxuICAgICAgfSlcbiAgICB9XG4gICAgaWYgKGZhaWxlZFBhdGNoKSB7XG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGF0Y2goe1xuICBwYXRjaEZpbGVQYXRoLFxuICByZXZlcnNlLFxuICBwYXRjaERldGFpbHMsXG4gIHBhdGNoRGlyLFxuICBjd2QsXG4gIGJlc3RFZmZvcnQsXG59OiB7XG4gIHBhdGNoRmlsZVBhdGg6IHN0cmluZ1xuICByZXZlcnNlOiBib29sZWFuXG4gIHBhdGNoRGV0YWlsczogUGFja2FnZURldGFpbHNcbiAgcGF0Y2hEaXI6IHN0cmluZ1xuICBjd2Q6IHN0cmluZ1xuICBiZXN0RWZmb3J0OiBib29sZWFuXG59KTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhdGNoID0gcmVhZFBhdGNoKHtcbiAgICBwYXRjaEZpbGVQYXRoLFxuICAgIHBhdGNoRGV0YWlscyxcbiAgICBwYXRjaERpcixcbiAgfSlcblxuICBjb25zdCBmb3J3YXJkID0gcmV2ZXJzZSA/IHJldmVyc2VQYXRjaChwYXRjaCkgOiBwYXRjaFxuICB0cnkge1xuICAgIGlmICghYmVzdEVmZm9ydCkge1xuICAgICAgZXhlY3V0ZUVmZmVjdHMoZm9yd2FyZCwgeyBkcnlSdW46IHRydWUsIGN3ZCwgYmVzdEVmZm9ydDogZmFsc2UgfSlcbiAgICB9XG4gICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCA9IGJlc3RFZmZvcnQgPyBbXSA6IHVuZGVmaW5lZFxuICAgIGV4ZWN1dGVFZmZlY3RzKGZvcndhcmQsIHsgZHJ5UnVuOiBmYWxzZSwgY3dkLCBiZXN0RWZmb3J0LCBlcnJvcnMgfSlcbiAgICBpZiAoZXJyb3JzPy5sZW5ndGgpIHtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBcIlNhdmluZyBlcnJvcnMgdG9cIixcbiAgICAgICAgY2hhbGsuY3lhbi5ib2xkKFwiLi9wYXRjaC1wYWNrYWdlLWVycm9ycy5sb2dcIiksXG4gICAgICApXG4gICAgICB3cml0ZUZpbGVTeW5jKFwicGF0Y2gtcGFja2FnZS1lcnJvcnMubG9nXCIsIGVycm9ycy5qb2luKFwiXFxuXFxuXCIpKVxuICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5sb2coZSk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJhY2t3YXJkID0gcmV2ZXJzZSA/IHBhdGNoIDogcmV2ZXJzZVBhdGNoKHBhdGNoKVxuICAgICAgZXhlY3V0ZUVmZmVjdHMoYmFja3dhcmQsIHtcbiAgICAgICAgZHJ5UnVuOiB0cnVlLFxuICAgICAgICBjd2QsXG4gICAgICAgIGJlc3RFZmZvcnQ6IGZhbHNlLFxuICAgICAgfSlcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmxvZyhlKTtcbiAgICAgIHJldHVybiBmYWxzZVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0cnVlXG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVZlcnNpb25NaXNtYXRjaFdhcm5pbmcoe1xuICBwYWNrYWdlTmFtZSxcbiAgYWN0dWFsVmVyc2lvbixcbiAgb3JpZ2luYWxWZXJzaW9uLFxuICBwYXRoU3BlY2lmaWVyLFxuICBwYXRoLFxufToge1xuICBwYWNrYWdlTmFtZTogc3RyaW5nXG4gIGFjdHVhbFZlcnNpb246IHN0cmluZ1xuICBvcmlnaW5hbFZlcnNpb246IHN0cmluZ1xuICBwYXRoU3BlY2lmaWVyOiBzdHJpbmdcbiAgcGF0aDogc3RyaW5nXG59KSB7XG4gIHJldHVybiBgXG4ke2NoYWxrLnllbGxvdyhcIldhcm5pbmc6XCIpfSBwYXRjaC1wYWNrYWdlIGRldGVjdGVkIGEgcGF0Y2ggZmlsZSB2ZXJzaW9uIG1pc21hdGNoXG5cbiAgRG9uJ3Qgd29ycnkhIFRoaXMgaXMgcHJvYmFibHkgZmluZS4gVGhlIHBhdGNoIHdhcyBzdGlsbCBhcHBsaWVkXG4gIHN1Y2Nlc3NmdWxseS4gSGVyZSdzIHRoZSBkZWV0czpcblxuICBQYXRjaCBmaWxlIGNyZWF0ZWQgZm9yXG5cbiAgICAke3BhY2thZ2VOYW1lfUAke2NoYWxrLmJvbGQob3JpZ2luYWxWZXJzaW9uKX1cblxuICBhcHBsaWVkIHRvXG5cbiAgICAke3BhY2thZ2VOYW1lfUAke2NoYWxrLmJvbGQoYWN0dWFsVmVyc2lvbil9XG4gIFxuICBBdCBwYXRoXG4gIFxuICAgICR7cGF0aH1cblxuICBUaGlzIHdhcm5pbmcgaXMganVzdCB0byBnaXZlIHlvdSBhIGhlYWRzLXVwLiBUaGVyZSBpcyBhIHNtYWxsIGNoYW5jZSBvZlxuICBicmVha2FnZSBldmVuIHRob3VnaCB0aGUgcGF0Y2ggd2FzIGFwcGxpZWQgc3VjY2Vzc2Z1bGx5LiBNYWtlIHN1cmUgdGhlIHBhY2thZ2VcbiAgc3RpbGwgYmVoYXZlcyBsaWtlIHlvdSBleHBlY3QgKHlvdSB3cm90ZSB0ZXN0cywgcmlnaHQ/KSBhbmQgdGhlbiBydW5cblxuICAgICR7Y2hhbGsuYm9sZChgcGF0Y2gtcGFja2FnZSAke3BhdGhTcGVjaWZpZXJ9YCl9XG5cbiAgdG8gdXBkYXRlIHRoZSB2ZXJzaW9uIGluIHRoZSBwYXRjaCBmaWxlIG5hbWUgYW5kIG1ha2UgdGhpcyB3YXJuaW5nIGdvIGF3YXkuXG5gXG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJyb2tlblBhdGNoRmlsZUVycm9yKHtcbiAgcGFja2FnZU5hbWUsXG4gIHBhdGNoRmlsZW5hbWUsXG4gIHBhdGgsXG4gIHBhdGhTcGVjaWZpZXIsXG59OiB7XG4gIHBhY2thZ2VOYW1lOiBzdHJpbmdcbiAgcGF0Y2hGaWxlbmFtZTogc3RyaW5nXG4gIHBhdGg6IHN0cmluZ1xuICBwYXRoU3BlY2lmaWVyOiBzdHJpbmdcbn0pIHtcbiAgcmV0dXJuIGBcbiR7Y2hhbGsucmVkLmJvbGQoXCIqKkVSUk9SKipcIil9ICR7Y2hhbGsucmVkKFxuICAgIGBGYWlsZWQgdG8gYXBwbHkgcGF0Y2ggZm9yIHBhY2thZ2UgJHtjaGFsay5ib2xkKHBhY2thZ2VOYW1lKX0gYXQgcGF0aGAsXG4gICl9XG4gIFxuICAgICR7cGF0aH1cblxuICBUaGlzIGVycm9yIHdhcyBjYXVzZWQgYmVjYXVzZSBwYXRjaC1wYWNrYWdlIGNhbm5vdCBhcHBseSB0aGUgZm9sbG93aW5nIHBhdGNoIGZpbGU6XG5cbiAgICBwYXRjaGVzLyR7cGF0Y2hGaWxlbmFtZX1cblxuICBUcnkgcmVtb3Zpbmcgbm9kZV9tb2R1bGVzIGFuZCB0cnlpbmcgYWdhaW4uIElmIHRoYXQgZG9lc24ndCB3b3JrLCBtYXliZSB0aGVyZSB3YXNcbiAgYW4gYWNjaWRlbnRhbCBjaGFuZ2UgbWFkZSB0byB0aGUgcGF0Y2ggZmlsZT8gVHJ5IHJlY3JlYXRpbmcgaXQgYnkgbWFudWFsbHlcbiAgZWRpdGluZyB0aGUgYXBwcm9wcmlhdGUgZmlsZXMgYW5kIHJ1bm5pbmc6XG4gIFxuICAgIHBhdGNoLXBhY2thZ2UgJHtwYXRoU3BlY2lmaWVyfVxuICBcbiAgSWYgdGhhdCBkb2Vzbid0IHdvcmssIHRoZW4gaXQncyBhIGJ1ZyBpbiBwYXRjaC1wYWNrYWdlLCBzbyBwbGVhc2Ugc3VibWl0IGEgYnVnXG4gIHJlcG9ydC4gVGhhbmtzIVxuXG4gICAgaHR0cHM6Ly9naXRodWIuY29tL2RzMzAwL3BhdGNoLXBhY2thZ2UvaXNzdWVzXG4gICAgXG5gXG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBhdGNoQXBwbGljYXRpb25GYWlsdXJlRXJyb3Ioe1xuICBwYWNrYWdlTmFtZSxcbiAgYWN0dWFsVmVyc2lvbixcbiAgb3JpZ2luYWxWZXJzaW9uLFxuICBwYXRjaEZpbGVuYW1lLFxuICBwYXRoLFxuICBwYXRoU3BlY2lmaWVyLFxufToge1xuICBwYWNrYWdlTmFtZTogc3RyaW5nXG4gIGFjdHVhbFZlcnNpb246IHN0cmluZ1xuICBvcmlnaW5hbFZlcnNpb246IHN0cmluZ1xuICBwYXRjaEZpbGVuYW1lOiBzdHJpbmdcbiAgcGF0aDogc3RyaW5nXG4gIHBhdGhTcGVjaWZpZXI6IHN0cmluZ1xufSkge1xuICByZXR1cm4gYFxuJHtjaGFsay5yZWQuYm9sZChcIioqRVJST1IqKlwiKX0gJHtjaGFsay5yZWQoXG4gICAgYEZhaWxlZCB0byBhcHBseSBwYXRjaCBmb3IgcGFja2FnZSAke2NoYWxrLmJvbGQocGFja2FnZU5hbWUpfSBhdCBwYXRoYCxcbiAgKX1cbiAgXG4gICAgJHtwYXRofVxuXG4gIFRoaXMgZXJyb3Igd2FzIGNhdXNlZCBiZWNhdXNlICR7Y2hhbGsuYm9sZChwYWNrYWdlTmFtZSl9IGhhcyBjaGFuZ2VkIHNpbmNlIHlvdVxuICBtYWRlIHRoZSBwYXRjaCBmaWxlIGZvciBpdC4gVGhpcyBpbnRyb2R1Y2VkIGNvbmZsaWN0cyB3aXRoIHlvdXIgcGF0Y2gsXG4gIGp1c3QgbGlrZSBhIG1lcmdlIGNvbmZsaWN0IGluIEdpdCB3aGVuIHNlcGFyYXRlIGluY29tcGF0aWJsZSBjaGFuZ2VzIGFyZVxuICBtYWRlIHRvIHRoZSBzYW1lIHBpZWNlIG9mIGNvZGUuXG5cbiAgTWF5YmUgdGhpcyBtZWFucyB5b3VyIHBhdGNoIGZpbGUgaXMgbm8gbG9uZ2VyIG5lY2Vzc2FyeSwgaW4gd2hpY2ggY2FzZVxuICBob29yYXkhIEp1c3QgZGVsZXRlIGl0IVxuXG4gIE90aGVyd2lzZSwgeW91IG5lZWQgdG8gZ2VuZXJhdGUgYSBuZXcgcGF0Y2ggZmlsZS5cblxuICBUbyBnZW5lcmF0ZSBhIG5ldyBvbmUsIGp1c3QgcmVwZWF0IHRoZSBzdGVwcyB5b3UgbWFkZSB0byBnZW5lcmF0ZSB0aGUgZmlyc3RcbiAgb25lLlxuXG4gIGkuZS4gbWFudWFsbHkgbWFrZSB0aGUgYXBwcm9wcmlhdGUgZmlsZSBjaGFuZ2VzLCB0aGVuIHJ1biBcblxuICAgIHBhdGNoLXBhY2thZ2UgJHtwYXRoU3BlY2lmaWVyfVxuXG4gIEluZm86XG4gICAgUGF0Y2ggZmlsZTogcGF0Y2hlcy8ke3BhdGNoRmlsZW5hbWV9XG4gICAgUGF0Y2ggd2FzIG1hZGUgZm9yIHZlcnNpb246ICR7Y2hhbGsuZ3JlZW4uYm9sZChvcmlnaW5hbFZlcnNpb24pfVxuICAgIEluc3RhbGxlZCB2ZXJzaW9uOiAke2NoYWxrLnJlZC5ib2xkKGFjdHVhbFZlcnNpb24pfVxuYFxufVxuXG5mdW5jdGlvbiBjcmVhdGVVbmV4cGVjdGVkRXJyb3Ioe1xuICBmaWxlbmFtZSxcbiAgZXJyb3IsXG59OiB7XG4gIGZpbGVuYW1lOiBzdHJpbmdcbiAgZXJyb3I6IEVycm9yXG59KSB7XG4gIHJldHVybiBgXG4ke2NoYWxrLnJlZC5ib2xkKFwiKipFUlJPUioqXCIpfSAke2NoYWxrLnJlZChcbiAgICBgRmFpbGVkIHRvIGFwcGx5IHBhdGNoIGZpbGUgJHtjaGFsay5ib2xkKGZpbGVuYW1lKX1gLFxuICApfVxuICBcbiR7ZXJyb3Iuc3RhY2t9XG5cbiAgYFxufVxuIl19