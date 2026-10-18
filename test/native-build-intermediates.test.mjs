import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pruneNativeBuildIntermediates } from "../scripts/native-build-intermediates.mjs";
import { MH_DSYM, MH_OBJECT, isSignableMachOCode, machOFiletypes } from "../scripts/macho.mjs";

// A 64-bit little-endian Mach-O header: magic, cputype, cpusubtype, filetype.
// This is what the real intermediates look like in the first 16 bytes, and it
// is the only part either module reads.
function machOHeader(filetype, { cputype = 0x01000007 } = {}) {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0xcffaedfe, 0); // bytes cf fa ed fe
  header.writeUInt32LE(cputype, 4);
  header.writeUInt32LE(3, 8);
  header.writeUInt32LE(filetype, 12);
  return header;
}

function writeFile(path, contents) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

// Mirrors the real cross-installed @paperclipai/server tree, measured
// 2026-10-18 from `npm install --production --os=darwin --cpu=x64 --arch=x64`
// on a linux-x64 host: 15 directories named `build`, of which exactly one
// (ssh2's native sshcrypto binding) is node-gyp output and 14 are compiled
// JavaScript. cpu-features does not install on linux, so its gyp tree — the
// one that failed `Release Desktop` #6 — is reconstructed from the layout in
// that run's log.
function writeBundleFixture(rootDir) {
  const nodeModules = join(rootDir, "server", "node_modules");

  const cpuFeaturesBuild = join(nodeModules, "cpu-features", "build");
  writeFile(join(cpuFeaturesBuild, "config.gypi"), "{}");
  writeFile(join(cpuFeaturesBuild, "Makefile"), "all:");
  writeFile(join(cpuFeaturesBuild, "cpu_features.target.mk"), "# target");
  writeFile(join(cpuFeaturesBuild, "Release", "cpu_features.node"), machOHeader(8)); // MH_BUNDLE
  writeFile(join(cpuFeaturesBuild, "Release", "obj.target", "cpu_features.node"), machOHeader(8));
  writeFile(
    join(cpuFeaturesBuild, "Release", "obj.target", "cpu_features", "deps", "cpu_features", "src", "filesystem.o"),
    machOHeader(MH_OBJECT),
  );
  writeFile(join(cpuFeaturesBuild, "Release", "libcpu_features.a"), "!<arch>\n");
  writeFile(join(cpuFeaturesBuild, "Release", ".deps", "Release", "obj.target", "x.o.d"), "dep");

  // ssh2 ships a gyp binding whose configure step runs but whose compile is
  // allowed to fail, so in the real tree it has markers and no Release output.
  const ssh2Build = join(nodeModules, "ssh2", "lib", "protocol", "crypto", "build");
  writeFile(join(ssh2Build, "config.gypi"), "{}");
  writeFile(join(ssh2Build, "binding.Makefile"), "all:");
  writeFile(join(ssh2Build, "sshcrypto.target.mk"), "# target");
  writeFile(join(ssh2Build, "Makefile"), "all:");

  // JavaScript `build/` directories. None carry a node-gyp marker.
  writeFile(join(nodeModules, "three", "build", "three.module.js"), "export {};");
  writeFile(join(nodeModules, "pino", "build", "cli.js"), "module.exports = {};");
  writeFile(join(nodeModules, "@grpc", "grpc-js", "build", "src", "index.js"), "module.exports = {};");
  // A JavaScript build dir whose filenames collide with intermediate names.
  writeFile(join(nodeModules, "yargs-parser", "build", "Makefile"), "# not gyp output");
  writeFile(join(nodeModules, "yargs-parser", "build", "lib", "index.js"), "module.exports = {};");

  // A shared library that is a real runtime output, not an intermediate.
  writeFile(
    join(nodeModules, "@embedded-postgres", "darwin-x64", "native", "lib", "libpq.5.dylib"),
    machOHeader(6), // MH_DYLIB
  );

  return nodeModules;
}

test("prunes the unsignable relocatable object that failed Release Desktop #6", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "prune-intermediates-"));

  try {
    const nodeModules = writeBundleFixture(rootDir);
    const objectPath = join(
      nodeModules,
      "cpu-features/build/Release/obj.target/cpu_features/deps/cpu_features/src/filesystem.o",
    );

    // The precondition for the CI failure: codesign is asked to verify a file
    // it can never have signed.
    assert.deepEqual(machOFiletypes(objectPath), [MH_OBJECT]);
    assert.equal(isSignableMachOCode(objectPath), false);

    const { removed } = pruneNativeBuildIntermediates({
      bundleServerDir: join(rootDir, "server"),
    });

    assert.equal(existsSync(objectPath), false);
    assert.ok(removed.includes(objectPath));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("keeps every loadable addon and shared library", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "prune-intermediates-"));

  try {
    const nodeModules = writeBundleFixture(rootDir);

    pruneNativeBuildIntermediates({ bundleServerDir: join(rootDir, "server") });

    // Both copies survive: `bindings` and `node-gyp-build` resolve the addon
    // through several paths, including the one inside obj.target.
    for (const kept of [
      "cpu-features/build/Release/cpu_features.node",
      "cpu-features/build/Release/obj.target/cpu_features.node",
      "@embedded-postgres/darwin-x64/native/lib/libpq.5.dylib",
    ]) {
      assert.ok(existsSync(join(nodeModules, kept)), `expected ${kept} to survive`);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("removes static archives, dependency lists and generated makefiles", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "prune-intermediates-"));

  try {
    const nodeModules = writeBundleFixture(rootDir);

    pruneNativeBuildIntermediates({ bundleServerDir: join(rootDir, "server") });

    for (const gone of [
      "cpu-features/build/Release/libcpu_features.a",
      "cpu-features/build/Release/.deps",
      "cpu-features/build/Makefile",
      "cpu-features/build/config.gypi",
      "cpu-features/build/cpu_features.target.mk",
      "ssh2/lib/protocol/crypto/build/binding.Makefile",
      "ssh2/lib/protocol/crypto/build/sshcrypto.target.mk",
    ]) {
      assert.equal(existsSync(join(nodeModules, gone)), false, `expected ${gone} to be pruned`);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The directory name `build` is not the signal: 14 of the 15 in the real tree
// hold compiled JavaScript. Pruning one would break the packaged server.
test("leaves JavaScript build directories untouched, including colliding filenames", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "prune-intermediates-"));

  try {
    const nodeModules = writeBundleFixture(rootDir);

    const { buildDirs } = pruneNativeBuildIntermediates({
      bundleServerDir: join(rootDir, "server"),
    });

    assert.deepEqual(
      buildDirs.map((dir) => dir.slice(nodeModules.length + 1)).sort(),
      ["cpu-features/build", "ssh2/lib/protocol/crypto/build"],
    );

    for (const kept of [
      "three/build/three.module.js",
      "pino/build/cli.js",
      "@grpc/grpc-js/build/src/index.js",
      "yargs-parser/build/lib/index.js",
      "yargs-parser/build/Makefile",
    ]) {
      assert.ok(existsSync(join(nodeModules, kept)), `expected ${kept} to survive`);
    }

    assert.equal(
      readFileSync(join(nodeModules, "yargs-parser/build/Makefile"), "utf8"),
      "# not gyp output",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fails loudly when the bundle's node_modules is absent", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "prune-intermediates-"));

  try {
    assert.throws(
      () => pruneNativeBuildIntermediates({ bundleServerDir: join(rootDir, "server") }),
      /does not exist/,
    );
    assert.throws(() => pruneNativeBuildIntermediates({}), /requires a bundleServerDir/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reads Mach-O filetypes, and keeps the signature requirement when unsure", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "macho-filetype-"));

  try {
    const cases = [
      ["executable", 2, true],
      ["dylib", 6, true],
      ["bundle", 8, true],
      ["object", MH_OBJECT, false],
      ["dsym", MH_DSYM, false],
    ];

    for (const [name, filetype, signable] of cases) {
      const path = join(rootDir, name);
      writeFileSync(path, machOHeader(filetype));
      assert.deepEqual(machOFiletypes(path), [filetype], name);
      assert.equal(isSignableMachOCode(path), signable, name);
    }

    // Anything that is not a readable Mach-O keeps the requirement, so an
    // unreadable header can never excuse an unsigned executable.
    const scriptPath = join(rootDir, "script.sh");
    writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
    assert.deepEqual(machOFiletypes(scriptPath), []);
    assert.equal(isSignableMachOCode(scriptPath), true);

    const truncatedPath = join(rootDir, "truncated");
    writeFileSync(truncatedPath, Buffer.from([0xcf, 0xfa]));
    assert.deepEqual(machOFiletypes(truncatedPath), []);
    assert.equal(isSignableMachOCode(truncatedPath), true);

    assert.deepEqual(machOFiletypes(join(rootDir, "missing")), []);
    assert.equal(isSignableMachOCode(join(rootDir, "missing")), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("follows a universal header into its slices", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "macho-fat-"));

  try {
    // fat_header: magic, nfat_arch (both big-endian), then two fat_arch
    // entries of cputype, cpusubtype, offset, size, align.
    const sliceOffsets = [4096, 8192];
    const fat = Buffer.alloc(sliceOffsets[1] + 32);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);

    for (const [index, offset] of sliceOffsets.entries()) {
      const entry = 8 + index * 20;
      fat.writeUInt32BE(0x01000007, entry);
      fat.writeUInt32BE(3, entry + 4);
      fat.writeUInt32BE(offset, entry + 8);
      fat.writeUInt32BE(32, entry + 12);
      fat.writeUInt32BE(12, entry + 16);
    }

    const universalExecutable = join(rootDir, "universal");
    machOHeader(2).copy(fat, sliceOffsets[0]);
    machOHeader(2).copy(fat, sliceOffsets[1]);
    writeFileSync(universalExecutable, fat);
    assert.deepEqual(machOFiletypes(universalExecutable), [2, 2]);
    assert.equal(isSignableMachOCode(universalExecutable), true);

    // Every slice must be unsignable before the requirement is dropped.
    const mixed = join(rootDir, "mixed");
    machOHeader(MH_OBJECT).copy(fat, sliceOffsets[1]);
    writeFileSync(mixed, fat);
    assert.deepEqual(machOFiletypes(mixed), [2, MH_OBJECT]);
    assert.equal(isSignableMachOCode(mixed), true);

    const universalObject = join(rootDir, "universal-object");
    machOHeader(MH_OBJECT).copy(fat, sliceOffsets[0]);
    writeFileSync(universalObject, fat);
    assert.deepEqual(machOFiletypes(universalObject), [MH_OBJECT, MH_OBJECT]);
    assert.equal(isSignableMachOCode(universalObject), false);

    // A Java class file also opens `cafebabe`. Its next four bytes are a
    // version, not a plausible slice count, so it reports nothing.
    const classFile = join(rootDir, "Thing.class");
    const classBytes = Buffer.alloc(64);
    classBytes.writeUInt32BE(0xcafebabe, 0);
    classBytes.writeUInt32BE(0x0000003d, 4);
    writeFileSync(classFile, classBytes);
    assert.deepEqual(machOFiletypes(classFile), []);
    assert.equal(isSignableMachOCode(classFile), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
