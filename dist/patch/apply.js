"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeEffects = void 0;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = require("path");
const assertNever_1 = require("../assertNever");
const executeEffects = (effects, { dryRun, bestEffort, errors, cwd, }) => {
    const inCwd = (path) => (cwd ? path_1.join(cwd, path) : path);
    const humanReadable = (path) => path_1.relative(process.cwd(), inCwd(path));
    effects.forEach((eff) => {
        switch (eff.type) {
            case "file deletion":
                if (dryRun) {
                    if (!fs_extra_1.default.existsSync(inCwd(eff.path))) {
                        throw new Error("Trying to delete file that doesn't exist: " +
                            humanReadable(eff.path));
                    }
                }
                else {
                    // TODO: integrity checks
                    try {
                        fs_extra_1.default.unlinkSync(inCwd(eff.path));
                    }
                    catch (e) {
                        if (bestEffort) {
                            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to delete file ${eff.path}`);
                        }
                        else {
                            throw e;
                        }
                    }
                }
                break;
            case "rename":
                if (dryRun) {
                    // TODO: see what patch files look like if moving to exising path
                    if (!fs_extra_1.default.existsSync(inCwd(eff.fromPath))) {
                        throw new Error("Trying to move file that doesn't exist: " +
                            humanReadable(eff.fromPath));
                    }
                }
                else {
                    try {
                        fs_extra_1.default.moveSync(inCwd(eff.fromPath), inCwd(eff.toPath));
                    }
                    catch (e) {
                        if (bestEffort) {
                            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to rename file ${eff.fromPath} to ${eff.toPath}`);
                        }
                        else {
                            throw e;
                        }
                    }
                }
                break;
            case "file creation":
                if (dryRun) {
                    if (fs_extra_1.default.existsSync(inCwd(eff.path))) {
                        throw new Error("Trying to create file that already exists: " +
                            humanReadable(eff.path));
                    }
                    // todo: check file contents matches
                }
                else {
                    const fileContents = eff.hunk
                        ? eff.hunk.parts[0].lines.join("\n") +
                            (eff.hunk.parts[0].noNewlineAtEndOfFile ? "" : "\n")
                        : "";
                    const path = inCwd(eff.path);
                    try {
                        fs_extra_1.default.ensureDirSync(path_1.dirname(path));
                        fs_extra_1.default.writeFileSync(path, fileContents, { mode: eff.mode });
                    }
                    catch (e) {
                        if (bestEffort) {
                            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to create new file ${eff.path}`);
                        }
                        else {
                            throw e;
                        }
                    }
                }
                break;
            case "patch":
                applyPatch(eff, { dryRun, cwd, bestEffort, errors });
                break;
            case "mode change":
                const currentMode = fs_extra_1.default.statSync(inCwd(eff.path)).mode;
                if (((isExecutable(eff.newMode) && isExecutable(currentMode)) ||
                    (!isExecutable(eff.newMode) && !isExecutable(currentMode))) &&
                    dryRun) {
                    console.log(`Mode change is not required for file ${humanReadable(eff.path)}`);
                }
                fs_extra_1.default.chmodSync(inCwd(eff.path), eff.newMode);
                break;
            default:
                assertNever_1.assertNever(eff);
        }
    });
};
exports.executeEffects = executeEffects;
function isExecutable(fileMode) {
    // tslint:disable-next-line:no-bitwise
    return (fileMode & 64) > 0;
}
const trimRight = (s) => s.replace(/\s+$/, "");
function linesAreEqual(a, b) {
    return trimRight(a) === trimRight(b);
}
/**
 * How does noNewLineAtEndOfFile work?
 *
 * if you remove the newline from a file that had one without editing other bits:
 *
 *    it creates an insertion/removal pair where the insertion has \ No new line at end of file
 *
 * if you edit a file that didn't have a new line and don't add one:
 *
 *    both insertion and deletion have \ No new line at end of file
 *
 * if you edit a file that didn't have a new line and add one:
 *
 *    deletion has \ No new line at end of file
 *    but not insertion
 *
 * if you edit a file that had a new line and leave it in:
 *
 *    neither insetion nor deletion have the annoation
 *
 */
function applyPatch({ hunks, path }, { dryRun, cwd, bestEffort, errors, }) {
    console.log(path);
    path = cwd ? path_1.resolve(cwd, path) : path;
    // modifying the file in place
    console.log(path);
    const fileContents = fs_extra_1.default.readFileSync(path).toString();
    const mode = fs_extra_1.default.statSync(path).mode;
    const fileLines = fileContents.split(/\n/);
    const result = [];
    for (const hunk of hunks) {
        let fuzzingOffset = 0;
        while (true) {
            const modifications = evaluateHunk(hunk, fileLines, fuzzingOffset);
            if (modifications) {
                result.push(modifications);
                break;
            }
            fuzzingOffset =
                fuzzingOffset < 0 ? fuzzingOffset * -1 : fuzzingOffset * -1 - 1;
            console.log(fuzzingOffset);
            if (Math.abs(fuzzingOffset) > 20) {
                const message = `Cannot apply hunk ${hunks.indexOf(hunk)} for file ${path_1.relative(process.cwd(), path)}\n\`\`\`diff\n${hunk.source}\n\`\`\`\n`;
                if (bestEffort) {
                    errors === null || errors === void 0 ? void 0 : errors.push(message);
                    break;
                }
                else {
                    throw new Error(message);
                }
            }
        }
    }
    if (dryRun) {
        return;
    }
    let diffOffset = 0;
    for (const modifications of result) {
        for (const modification of modifications) {
            switch (modification.type) {
                case "splice":
                    fileLines.splice(modification.index + diffOffset, modification.numToDelete, ...modification.linesToInsert);
                    diffOffset +=
                        modification.linesToInsert.length - modification.numToDelete;
                    break;
                case "pop":
                    fileLines.pop();
                    break;
                case "push":
                    fileLines.push(modification.line);
                    break;
                default:
                    assertNever_1.assertNever(modification);
            }
        }
    }
    try {
        fs_extra_1.default.writeFileSync(path, fileLines.join("\n"), { mode });
    }
    catch (e) {
        if (bestEffort) {
            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to write file ${path}`);
        }
        else {
            throw e;
        }
    }
}
function evaluateHunk(hunk, fileLines, fuzzingOffset) {
    const result = [];
    let contextIndex = hunk.header.original.start - 1 + fuzzingOffset;
    // do bounds checks for index
    if (contextIndex < 0) {
        console.log("contextIndex < 0");
        return null;
    }
    if (fileLines.length - contextIndex < hunk.header.original.length) {
        console.log("fileLines.length - contextIndex < hunk.header.original.length");
        return null;
    }
    for (const part of hunk.parts) {
        switch (part.type) {
            case "deletion":
            case "context":
                for (const line of part.lines) {
                    const originalLine = fileLines[contextIndex];
                    if (!linesAreEqual(originalLine, line)) {
                        console.log("!linesAreEqual(originalLine, line)");
                        return null;
                    }
                    contextIndex++;
                }
                if (part.type === "deletion") {
                    result.push({
                        type: "splice",
                        index: contextIndex - part.lines.length,
                        numToDelete: part.lines.length,
                        linesToInsert: [],
                    });
                    if (part.noNewlineAtEndOfFile) {
                        result.push({
                            type: "push",
                            line: "",
                        });
                    }
                }
                break;
            case "insertion":
                result.push({
                    type: "splice",
                    index: contextIndex,
                    numToDelete: 0,
                    linesToInsert: part.lines,
                });
                if (part.noNewlineAtEndOfFile) {
                    result.push({ type: "pop" });
                }
                break;
            default:
                assertNever_1.assertNever(part.type);
        }
    }
    return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvcGF0Y2gvYXBwbHkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUEsd0RBQXlCO0FBQ3pCLCtCQUF1RDtBQUV2RCxnREFBNEM7QUFFckMsTUFBTSxjQUFjLEdBQUcsQ0FDNUIsT0FBd0IsRUFDeEIsRUFDRSxNQUFNLEVBQ04sVUFBVSxFQUNWLE1BQU0sRUFDTixHQUFHLEdBQ3VFLEVBQzVFLEVBQUU7SUFDRixNQUFNLEtBQUssR0FBRyxDQUFDLElBQVksRUFBRSxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLFdBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFBO0lBQzlELE1BQU0sYUFBYSxHQUFHLENBQUMsSUFBWSxFQUFFLEVBQUUsQ0FBQyxlQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFBO0lBQzVFLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRTtRQUN0QixRQUFRLEdBQUcsQ0FBQyxJQUFJLEVBQUU7WUFDaEIsS0FBSyxlQUFlO2dCQUNsQixJQUFJLE1BQU0sRUFBRTtvQkFDVixJQUFJLENBQUMsa0JBQUUsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFO3dCQUNuQyxNQUFNLElBQUksS0FBSyxDQUNiLDRDQUE0Qzs0QkFDMUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FDMUIsQ0FBQTtxQkFDRjtpQkFDRjtxQkFBTTtvQkFDTCx5QkFBeUI7b0JBQ3pCLElBQUk7d0JBQ0Ysa0JBQUUsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFBO3FCQUMvQjtvQkFBQyxPQUFPLENBQUMsRUFB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aW1wb3J0IHsgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUgfSBmcm9tIFwicGF0aFwiXG5pbXBvcnQgeyBQYXJzZWRQYXRjaEZpbGUsIEZpbGVQYXRjaCwgSHVuayB9IGZyb20gXCIuL3BhcnNlXCJcbmltcG9ydCB7IGFzc2VydE5ldmVyIH0gZnJvbSBcIi4uL2Fzc2VydE5ldmVyXCJcblxuZXhwb3J0IGNvbnN0IGV4ZWN1dGVFZmZlY3RzID0gKFxuICBlZmZlY3RzOiBQYXJzZWRQYXRjaEZpbGUsXG4gIHtcbiAgICBkcnlSdW4sXG4gICAgYmVzdEVmZm9ydCxcbiAgICBlcnJvcnMsXG4gICAgY3dkLFxuICB9OiB7IGRyeVJ1bjogYm9vbGVhbjsgY3dkPzogc3RyaW5nOyBlcnJvcnM/OiBzdHJpbmdbXTsgYmVzdEVmZm9ydDogYm9vbGVhbiB9LFxuKSA9PiB7XG4gIGNvbnN0IGluQ3dkID0gKHBhdGg6IHN0cmluZykgPT4gKGN3ZCA/IGpvaW4oY3dkLCBwYXRoKSA6IHBhdGgpXG4gIGNvbnN0IGh1bWFuUmVhZGFibGUgPSAocGF0aDogc3RyaW5nKSA9PiByZWxhdGl2ZShwcm9jZXNzLmN3ZCgpLCBpbkN3ZChwYXRoKSlcbiAgZWZmZWN0cy5mb3JFYWNoKChlZmYpID0+IHtcbiAgICBzd2l0Y2ggKGVmZi50eXBlKSB7XG4gICAgICBjYXNlIFwiZmlsZSBkZWxldGlvblwiOlxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKGluQ3dkKGVmZi5wYXRoKSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgXCJUcnlpbmcgdG8gZGVsZXRlIGZpbGUgdGhhdCBkb2Vzbid0IGV4aXN0OiBcIiArXG4gICAgICAgICAgICAgICAgaHVtYW5SZWFkYWJsZShlZmYucGF0aCksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRPRE86IGludGVncml0eSBjaGVja3NcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgZnMudW5saW5rU3luYyhpbkN3ZChlZmYucGF0aCkpXG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgaWYgKGJlc3RFZmZvcnQpIHtcbiAgICAgICAgICAgICAgZXJyb3JzPy5wdXNoKGBGYWlsZWQgdG8gZGVsZXRlIGZpbGUgJHtlZmYucGF0aH1gKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgZVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSBcInJlbmFtZVwiOlxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgLy8gVE9ETzogc2VlIHdoYXQgcGF0Y2ggZmlsZXMgbG9vayBsaWtlIGlmIG1vdmluZyB0byBleGlzaW5nIHBhdGhcbiAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMoaW5Dd2QoZWZmLmZyb21QYXRoKSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgXCJUcnlpbmcgdG8gbW92ZSBmaWxlIHRoYXQgZG9lc24ndCBleGlzdDogXCIgK1xuICAgICAgICAgICAgICAgIGh1bWFuUmVhZGFibGUoZWZmLmZyb21QYXRoKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZzLm1vdmVTeW5jKGluQ3dkKGVmZi5mcm9tUGF0aCksIGluQ3dkKGVmZi50b1BhdGgpKVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGlmIChiZXN0RWZmb3J0KSB7XG4gICAgICAgICAgICAgIGVycm9ycz8ucHVzaChcbiAgICAgICAgICAgICAgICBgRmFpbGVkIHRvIHJlbmFtZSBmaWxlICR7ZWZmLmZyb21QYXRofSB0byAke2VmZi50b1BhdGh9YCxcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgZVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSBcImZpbGUgY3JlYXRpb25cIjpcbiAgICAgICAgaWYgKGRyeVJ1bikge1xuICAgICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGluQ3dkKGVmZi5wYXRoKSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgXCJUcnlpbmcgdG8gY3JlYXRlIGZpbGUgdGhhdCBhbHJlYWR5IGV4aXN0czogXCIgK1xuICAgICAgICAgICAgICAgIGh1bWFuUmVhZGFibGUoZWZmLnBhdGgpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgICAvLyB0b2RvOiBjaGVjayBmaWxlIGNvbnRlbnRzIG1hdGNoZXNcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBmaWxlQ29udGVudHMgPSBlZmYuaHVua1xuICAgICAgICAgICAgPyBlZmYuaHVuay5wYXJ0c1swXS5saW5lcy5qb2luKFwiXFxuXCIpICtcbiAgICAgICAgICAgICAgKGVmZi5odW5rLnBhcnRzWzBdLm5vTmV3bGluZUF0RW5kT2ZGaWxlID8gXCJcIiA6IFwiXFxuXCIpXG4gICAgICAgICAgICA6IFwiXCJcbiAgICAgICAgICBjb25zdCBwYXRoID0gaW5Dd2QoZWZmLnBhdGgpXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZzLmVuc3VyZURpclN5bmMoZGlybmFtZShwYXRoKSlcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aCwgZmlsZUNvbnRlbnRzLCB7IG1vZGU6IGVmZi5tb2RlIH0pXG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgaWYgKGJlc3RFZmZvcnQpIHtcbiAgICAgICAgICAgICAgZXJyb3JzPy5wdXNoKGBGYWlsZWQgdG8gY3JlYXRlIG5ldyBmaWxlICR7ZWZmLnBhdGh9YClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IGVcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgXCJwYXRjaFwiOlxuICAgICAgICBhcHBseVBhdGNoKGVmZiwgeyBkcnlSdW4sIGN3ZCwgYmVzdEVmZm9ydCwgZXJyb3JzIH0pXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlIFwibW9kZSBjaGFuZ2VcIjpcbiAgICAgICAgY29uc3QgY3VycmVudE1vZGUgPSBmcy5zdGF0U3luYyhpbkN3ZChlZmYucGF0aCkpLm1vZGVcbiAgICAgICAgaWYgKFxuICAgICAgICAgICgoaXNFeGVjdXRhYmxlKGVmZi5uZXdNb2RlKSAmJiBpc0V4ZWN1dGFibGUoY3VycmVudE1vZGUpKSB8fFxuICAgICAgICAgICAgKCFpc0V4ZWN1dGFibGUoZWZmLm5ld01vZGUpICYmICFpc0V4ZWN1dGFibGUoY3VycmVudE1vZGUpKSkgJiZcbiAgICAgICAgICBkcnlSdW5cbiAgICAgICAgKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgICBgTW9kZSBjaGFuZ2UgaXMgbm90IHJlcXVpcmVkIGZvciBmaWxlICR7aHVtYW5SZWFkYWJsZShlZmYucGF0aCl9YCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgZnMuY2htb2RTeW5jKGluQ3dkKGVmZi5wYXRoKSwgZWZmLm5ld01vZGUpXG4gICAgICAgIGJyZWFrXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBhc3NlcnROZXZlcihlZmYpXG4gICAgfVxuICB9KVxufVxuXG5mdW5jdGlvbiBpc0V4ZWN1dGFibGUoZmlsZU1vZGU6IG51bWJlcikge1xuICAvLyB0c2xpbnQ6ZGlzYWJsZS1uZXh0LWxpbmU6bm8tYml0d2lzZVxuICByZXR1cm4gKGZpbGVNb2RlICYgMGIwMDFfMDAwXzAwMCkgPiAwXG59XG5cbmNvbnN0IHRyaW1SaWdodCA9IChzOiBzdHJpbmcpID0+IHMucmVwbGFjZSgvXFxzKyQvLCBcIlwiKVxuZnVuY3Rpb24gbGluZXNBcmVFcXVhbChhOiBzdHJpbmcsIGI6IHN0cmluZykge1xuICByZXR1cm4gdHJpbVJpZ2h0KGEpID09PSB0cmltUmlnaHQoYilcbn1cblxuLyoqXG4gKiBIb3cgZG9lcyBub05ld0xpbmVBdEVuZE9mRmlsZSB3b3JrP1xuICpcbiAqIGlmIHlvdSByZW1vdmUgdGhlIG5ld2xpbmUgZnJvbSBhIGZpbGUgdGhhdCBoYWQgb25lIHdpdGhvdXQgZWRpdGluZyBvdGhlciBiaXRzOlxuICpcbiAqICAgIGl0IGNyZWF0ZXMgYW4gaW5zZXJ0aW9uL3JlbW92YWwgcGFpciB3aGVyZSB0aGUgaW5zZXJ0aW9uIGhhcyBcXCBObyBuZXcgbGluZSBhdCBlbmQgb2YgZmlsZVxuICpcbiAqIGlmIHlvdSBlZGl0IGEgZmlsZSB0aGF0IGRpZG4ndCBoYXZlIGEgbmV3IGxpbmUgYW5kIGRvbid0IGFkZCBvbmU6XG4gKlxuICogICAgYm90aCBpbnNlcnRpb24gYW5kIGRlbGV0aW9uIGhhdmUgXFwgTm8gbmV3IGxpbmUgYXQgZW5kIG9mIGZpbGVcbiAqXG4gKiBpZiB5b3UgZWRpdCBhIGZpbGUgdGhhdCBkaWRuJ3QgaGF2ZSBhIG5ldyBsaW5lIGFuZCBhZGQgb25lOlxuICpcbiAqICAgIGRlbGV0aW9uIGhhcyBcXCBObyBuZXcgbGluZSBhdCBlbmQgb2YgZmlsZVxuICogICAgYnV0IG5vdCBpbnNlcnRpb25cbiAqXG4gKiBpZiB5b3UgZWRpdCBhIGZpbGUgdGhhdCBoYWQgYSBuZXcgbGluZSBhbmQgbGVhdmUgaXQgaW46XG4gKlxuICogICAgbmVpdGhlciBpbnNldGlvbiBub3IgZGVsZXRpb24gaGF2ZSB0aGUgYW5ub2F0aW9uXG4gKlxuICovXG5cbmZ1bmN0aW9uIGFwcGx5UGF0Y2goXG4gIHsgaHVua3MsIHBhdGggfTogRmlsZVBhdGNoLFxuICB7XG4gICAgZHJ5UnVuLFxuICAgIGN3ZCxcbiAgICBiZXN0RWZmb3J0LFxuICAgIGVycm9ycyxcbiAgfTogeyBkcnlSdW46IGJvb2xlYW47IGN3ZD86IHN0cmluZzsgYmVzdEVmZm9ydDogYm9vbGVhbjsgZXJyb3JzPzogc3RyaW5nW10gfSxcbik6IHZvaWQge1xuICBjb25zb2xlLmxvZyhwYXRoKTtcbiAgcGF0aCA9IGN3ZCA/IHJlc29sdmUoY3dkLCBwYXRoKSA6IHBhdGhcbiAgLy8gbW9kaWZ5aW5nIHRoZSBmaWxlIGluIHBsYWNlXG4gIGNvbnNvbGUubG9nKHBhdGgpO1xuICBjb25zdCBmaWxlQ29udGVudHMgPSBmcy5yZWFkRmlsZVN5bmMocGF0aCkudG9TdHJpbmcoKVxuICBjb25zdCBtb2RlID0gZnMuc3RhdFN5bmMocGF0aCkubW9kZVxuXG4gIGNvbnN0IGZpbGVMaW5lczogc3RyaW5nW10gPSBmaWxlQ29udGVudHMuc3BsaXQoL1xcbi8pXG5cbiAgY29uc3QgcmVzdWx0OiBNb2RpZmljYXRpb25bXVtdID0gW11cblxuICBmb3IgKGNvbnN0IGh1bmsgb2YgaHVua3MpIHtcbiAgICBsZXQgZnV6emluZ09mZnNldCA9IDBcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgY29uc3QgbW9kaWZpY2F0aW9ucyA9IGV2YWx1YXRlSHVuayhodW5rLCBmaWxlTGluZXMsIGZ1enppbmdPZmZzZXQpXG4gICAgICBpZiAobW9kaWZpY2F0aW9ucykge1xuICAgICAgICByZXN1bHQucHVzaChtb2RpZmljYXRpb25zKVxuICAgICAgICBicmVha1xuICAgICAgfVxuXG4gICAgICBmdXp6aW5nT2Zmc2V0ID1cbiAgICAgICAgZnV6emluZ09mZnNldCA8IDAgPyBmdXp6aW5nT2Zmc2V0ICogLTEgOiBmdXp6aW5nT2Zmc2V0ICogLTEgLSAxXG4gICAgICBjb25zb2xlLmxvZyhmdXp6aW5nT2Zmc2V0KTtcbiAgICAgIGlmIChNYXRoLmFicyhmdXp6aW5nT2Zmc2V0KSA+IDIwKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgQ2Fubm90IGFwcGx5IGh1bmsgJHtodW5rcy5pbmRleE9mKFxuICAgICAgICAgIGh1bmssXG4gICAgICAgICl9IGZvciBmaWxlICR7cmVsYXRpdmUocHJvY2Vzcy5jd2QoKSwgcGF0aCl9XFxuXFxgXFxgXFxgZGlmZlxcbiR7XG4gICAgICAgICAgaHVuay5zb3VyY2VcbiAgICAgICAgfVxcblxcYFxcYFxcYFxcbmBcblxuICAgICAgICBpZiAoYmVzdEVmZm9ydCkge1xuICAgICAgICAgIGVycm9ycz8ucHVzaChtZXNzYWdlKVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAoZHJ5UnVuKSB7XG4gICAgcmV0dXJuXG4gIH1cblxuICBsZXQgZGlmZk9mZnNldCA9IDBcblxuICBmb3IgKGNvbnN0IG1vZGlmaWNhdGlvbnMgb2YgcmVzdWx0KSB7XG4gICAgZm9yIChjb25zdCBtb2RpZmljYXRpb24gb2YgbW9kaWZpY2F0aW9ucykge1xuICAgICAgc3dpdGNoIChtb2RpZmljYXRpb24udHlwZSkge1xuICAgICAgICBjYXNlIFwic3BsaWNlXCI6XG4gICAgICAgICAgZmlsZUxpbmVzLnNwbGljZShcbiAgICAgICAgICAgIG1vZGlmaWNhdGlvbi5pbmRleCArIGRpZmZPZmZzZXQsXG4gICAgICAgICAgICBtb2RpZmljYXRpb24ubnVtVG9EZWxldGUsXG4gICAgICAgICAgICAuLi5tb2RpZmljYXRpb24ubGluZXNUb0luc2VydCxcbiAgICAgICAgICApXG4gICAgICAgICAgZGlmZk9mZnNldCArPVxuICAgICAgICAgICAgbW9kaWZpY2F0aW9uLmxpbmVzVG9JbnNlcnQubGVuZ3RoIC0gbW9kaWZpY2F0aW9uLm51bVRvRGVsZXRlXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgY2FzZSBcInBvcFwiOlxuICAgICAgICAgIGZpbGVMaW5lcy5wb3AoKVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGNhc2UgXCJwdXNoXCI6XG4gICAgICAgICAgZmlsZUxpbmVzLnB1c2gobW9kaWZpY2F0aW9uLmxpbmUpXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBhc3NlcnROZXZlcihtb2RpZmljYXRpb24pXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgdHJ5IHtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGgsIGZpbGVMaW5lcy5qb2luKFwiXFxuXCIpLCB7IG1vZGUgfSlcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChiZXN0RWZmb3J0KSB7XG4gICAgICBlcnJvcnM/LnB1c2goYEZhaWxlZCB0byB3cml0ZSBmaWxlICR7cGF0aH1gKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBlXG4gICAgfVxuICB9XG59XG5cbmludGVyZmFjZSBQdXNoIHtcbiAgdHlwZTogXCJwdXNoXCJcbiAgbGluZTogc3RyaW5nXG59XG5pbnRlcmZhY2UgUG9wIHtcbiAgdHlwZTogXCJwb3BcIlxufVxuaW50ZXJmYWNlIFNwbGljZSB7XG4gIHR5cGU6IFwic3BsaWNlXCJcbiAgaW5kZXg6IG51bWJlclxuICBudW1Ub0RlbGV0ZTogbnVtYmVyXG4gIGxpbmVzVG9JbnNlcnQ6IHN0cmluZ1tdXG59XG5cbnR5cGUgTW9kaWZpY2F0aW9uID0gUHVzaCB8IFBvcCB8IFNwbGljZVxuXG5mdW5jdGlvbiBldmFsdWF0ZUh1bmsoXG4gIGh1bms6IEh1bmssXG4gIGZpbGVMaW5lczogc3RyaW5nW10sXG4gIGZ1enppbmdPZmZzZXQ6IG51bWJlcixcbik6IE1vZGlmaWNhdGlvbltdIHwgbnVsbCB7XG4gIGNvbnN0IHJlc3VsdDogTW9kaWZpY2F0aW9uW10gPSBbXVxuICBsZXQgY29udGV4dEluZGV4ID0gaHVuay5oZWFkZXIub3JpZ2luYWwuc3RhcnQgLSAxICsgZnV6emluZ09mZnNldFxuICAvLyBkbyBib3VuZHMgY2hlY2tzIGZvciBpbmRleFxuICBpZiAoY29udGV4dEluZGV4IDwgMCkge1xuICAgIGNvbnNvbGUubG9nKFwiY29udGV4dEluZGV4IDwgMFwiKTtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIGlmIChmaWxlTGluZXMubGVuZ3RoIC0gY29udGV4dEluZGV4IDwgaHVuay5oZWFkZXIub3JpZ2luYWwubGVuZ3RoKSB7XG4gICAgY29uc29sZS5sb2coXCJmaWxlTGluZXMubGVuZ3RoIC0gY29udGV4dEluZGV4IDwgaHVuay5oZWFkZXIub3JpZ2luYWwubGVuZ3RoXCIpO1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBmb3IgKGNvbnN0IHBhcnQgb2YgaHVuay5wYXJ0cykge1xuICAgIHN3aXRjaCAocGFydC50eXBlKSB7XG4gICAgICBjYXNlIFwiZGVsZXRpb25cIjpcbiAgICAgIGNhc2UgXCJjb250ZXh0XCI6XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBwYXJ0LmxpbmVzKSB7XG4gICAgICAgICAgY29uc3Qgb3JpZ2luYWxMaW5lID0gZmlsZUxpbmVzW2NvbnRleHRJbmRleF1cbiAgICAgICAgICBpZiAoIWxpbmVzQXJlRXF1YWwob3JpZ2luYWxMaW5lLCBsaW5lKSkge1xuICAgICAgICAgICAgY29uc29sZS5sb2coXCIhbGluZXNBcmVFcXVhbChvcmlnaW5hbExpbmUsIGxpbmUpXCIpO1xuICAgICAgICAgICAgcmV0dXJuIG51bGxcbiAgICAgICAgICB9XG4gICAgICAgICAgY29udGV4dEluZGV4KytcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChwYXJ0LnR5cGUgPT09IFwiZGVsZXRpb25cIikge1xuICAgICAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgICAgIHR5cGU6IFwic3BsaWNlXCIsXG4gICAgICAgICAgICBpbmRleDogY29udGV4dEluZGV4IC0gcGFydC5saW5lcy5sZW5ndGgsXG4gICAgICAgICAgICBudW1Ub0RlbGV0ZTogcGFydC5saW5lcy5sZW5ndGgsXG4gICAgICAgICAgICBsaW5lc1RvSW5zZXJ0OiBbXSxcbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgaWYgKHBhcnQubm9OZXdsaW5lQXRFbmRPZkZpbGUpIHtcbiAgICAgICAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgICAgICAgdHlwZTogXCJwdXNoXCIsXG4gICAgICAgICAgICAgIGxpbmU6IFwiXCIsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSBcImluc2VydGlvblwiOlxuICAgICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgICAgdHlwZTogXCJzcGxpY2VcIixcbiAgICAgICAgICBpbmRleDogY29udGV4dEluZGV4LFxuICAgICAgICAgIG51bVRvRGVsZXRlOiAwLFxuICAgICAgICAgIGxpbmVzVG9JbnNlcnQ6IHBhcnQubGluZXMsXG4gICAgICAgIH0pXG4gICAgICAgIGlmIChwYXJ0Lm5vTmV3bGluZUF0RW5kT2ZGaWxlKSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2goeyB0eXBlOiBcInBvcFwiIH0pXG4gICAgICAgIH1cbiAgICAgICAgYnJlYWtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGFzc2VydE5ldmVyKHBhcnQudHlwZSlcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0XG59XG4iXX0=