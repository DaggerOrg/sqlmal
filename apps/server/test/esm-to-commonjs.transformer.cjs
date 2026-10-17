// Jest on Node 22 cannot require() ES modules, and NestJS 12 ships only ES modules. This
// transformer rewrites ES module files from node_modules into CommonJS for the test run.
// Files that are already CommonJS pass through untouched.
const { createHash } = require('node:crypto');
const typescript = require('typescript');

const ESM_SYNTAX = /^\s*(?:import\s|import\{|export\s|export\{|export\*)/m;

function isEsModule(source, filename) {
  return filename.endsWith('.mjs') || ESM_SYNTAX.test(source);
}

module.exports = {
  getCacheKey(source, filename) {
    return createHash('sha256').update(filename).update('\0').update(source).update('\0v1').digest('hex');
  },
  process(source, filename) {
    if (!isEsModule(source, filename)) {
      return { code: source };
    }
    const withoutImportMeta = source.replace(/\bimport\.meta\.url\b/g, "require('node:url').pathToFileURL(__filename).href");
    const output = typescript.transpileModule(withoutImportMeta, {
      fileName: filename,
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2022,
        allowJs: true,
        esModuleInterop: true,
        sourceMap: false,
      },
    });
    return { code: output.outputText };
  },
};
