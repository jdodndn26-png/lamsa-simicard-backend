/**
 * Backend Usage Analyzer
 * يحلل كل ملفات الباك إند ويشوف إيه المستخدم وإيه المش مستخدم
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

// كل الملفات اللي هنحللها
const SCAN_DIRS = ["config", "controllers", "models", "routes", "services"];
const ROOT_FILES = [
  "server.js",
  "seed-admin.js",
  "seed-products.js",
  "seed-products-stc.js",
  "update-internet-sims.js",
];

// ملفات نتجاهلها
const IGNORE = new Set([
  "analyze-usage.js",
  "package.json",
  "package-lock.json",
  ".env",
  ".env.example",
  ".gitignore",
  "vercel.json",
  "README.md",
  "server.log",
]);

function getAllJsFiles() {
  const files = [];

  // ملفات الروت
  for (const f of ROOT_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push(full);
  }

  // ملفات الفولدرات
  for (const dir of SCAN_DIRS) {
    const dirPath = path.join(ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const f of fs.readdirSync(dirPath)) {
      if (f.endsWith(".js")) files.push(path.join(dirPath, f));
    }
  }

  return files;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// استخرج كل الـ require/import من ملف
function extractImports(content) {
  const imports = new Set();

  // require('./xxx') or require('../xxx')
  const requireRegex = /require\s*\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g;
  let m;
  while ((m = requireRegex.exec(content)) !== null) {
    imports.add(m[1]);
  }

  // import ... from './xxx'
  const importRegex = /from\s+['"`](\.{1,2}\/[^'"`]+)['"`]/g;
  while ((m = importRegex.exec(content)) !== null) {
    imports.add(m[1]);
  }

  return imports;
}

function resolveImport(fromFile, importPath) {
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importPath);

  // لو مفيش امتداد، جرب .js
  if (!path.extname(resolved)) resolved += ".js";

  return resolved;
}

function analyze() {
  const allFiles = getAllJsFiles();
  const allFilesSet = new Set(allFiles.map((f) => f.toLowerCase()));

  // كل ملف → الملفات اللي بتعمله import
  const importedBy = new Map(); // filePath → Set of importers
  for (const f of allFiles) importedBy.set(f.toLowerCase(), new Set());

  // ابني الـ dependency graph
  for (const file of allFiles) {
    const content = readFile(file);
    const imports = extractImports(content);

    for (const imp of imports) {
      const resolved = resolveImport(file, imp).toLowerCase();
      if (importedBy.has(resolved)) {
        importedBy.get(resolved).add(file);
      }
    }
  }

  // server.js هو نقطة البداية - مش محتاج حد يعمله import
  const entryPoints = new Set(
    ["server.js", "seed-admin.js", "seed-products.js", "seed-products-stc.js", "update-internet-sims.js"]
      .map((f) => path.join(ROOT, f).toLowerCase())
  );

  console.log("\n" + "=".repeat(60));
  console.log("       📊 Backend Usage Analysis");
  console.log("=".repeat(60));

  const unused = [];
  const used = [];

  for (const file of allFiles) {
    const key = file.toLowerCase();
    const isEntry = entryPoints.has(key);
    const importers = importedBy.get(key) || new Set();
    const isUsed = isEntry || importers.size > 0;

    const rel = path.relative(ROOT, file);

    if (isUsed) {
      used.push({ rel, isEntry, importers: [...importers].map((i) => path.relative(ROOT, i)) });
    } else {
      unused.push(rel);
    }
  }

  // ✅ المستخدمة
  console.log("\n✅ USED FILES:\n");
  for (const { rel, isEntry, importers } of used) {
    if (isEntry) {
      console.log(`  ✅ ${rel}  ← [entry point]`);
    } else {
      console.log(`  ✅ ${rel}  ← imported by: ${importers.join(", ")}`);
    }
  }

  // ❌ المش مستخدمة
  console.log("\n❌ UNUSED FILES (not imported by anything):\n");
  if (unused.length === 0) {
    console.log("  🎉 كل الملفات مستخدمة!");
  } else {
    for (const rel of unused) {
      console.log(`  ❌ ${rel}`);
    }
  }

  // تحقق من الـ packages المستخدمة vs المثبتة
  console.log("\n" + "=".repeat(60));
  console.log("       📦 Package Usage Check");
  console.log("=".repeat(60));

  const pkg = JSON.parse(readFile(path.join(ROOT, "package.json")));
  const installedDeps = Object.keys(pkg.dependencies || {});

  // اقرأ كل الملفات وشوف الـ packages المستخدمة
  const usedPackages = new Set();
  for (const file of allFiles) {
    const content = readFile(file);
    // require('package') - not relative
    const pkgRequire = /require\s*\(\s*['"`]([^./'"`][^'"`]*)['"`]\s*\)/g;
    let m;
    while ((m = pkgRequire.exec(content)) !== null) {
      // خد الاسم الأساسي بس (مش sub-path)
      const name = m[1].startsWith("@")
        ? m[1].split("/").slice(0, 2).join("/")
        : m[1].split("/")[0];
      usedPackages.add(name);
    }
  }

  console.log("\n📦 Installed packages status:\n");
  const unusedPkgs = [];
  for (const dep of installedDeps) {
    if (usedPackages.has(dep)) {
      console.log(`  ✅ ${dep}`);
    } else {
      unusedPkgs.push(dep);
      console.log(`  ❌ ${dep}  ← not found in any require()`);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("       📋 Summary");
  console.log("=".repeat(60));
  console.log(`\n  Total files scanned : ${allFiles.length}`);
  console.log(`  Used files          : ${used.length}`);
  console.log(`  Unused files        : ${unused.length}`);
  console.log(`  Installed packages  : ${installedDeps.length}`);
  console.log(`  Unused packages     : ${unusedPkgs.length}`);

  if (unused.length > 0) {
    console.log(`\n  ⚠️  Unused files:\n${unused.map((f) => `     - ${f}`).join("\n")}`);
  }
  if (unusedPkgs.length > 0) {
    console.log(`\n  ⚠️  Unused packages:\n${unusedPkgs.map((p) => `     - ${p}`).join("\n")}`);
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

analyze();
