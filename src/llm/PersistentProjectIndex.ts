import { Dirent, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ts from 'typescript';

export type IndexedSymbolKind = 'class' | 'enum' | 'function' | 'interface' | 'method' | 'type' | 'variable';
export type IndexedImportKind = 'export-from' | 'import' | 'require';
export type AnalysisMode = 'ast' | 'text';

export interface IndexedSymbol {
  id: string;
  name: string;
  shortName: string;
  searchNames: string[];
  kind: IndexedSymbolKind;
  line: number;
  exported: boolean;
  parentName?: string;
}

export interface IndexedImport {
  specifier: string;
  importedNames: string[];
  kind: IndexedImportKind;
}

export interface IndexedCallSite {
  callerSymbolId: string;
  callerName: string;
  calleeName: string;
  expression: string;
}

export interface IndexedProjectFile {
  relativePath: string;
  fileNameLower: string;
  extension: string;
  language: string;
  sizeBytes: number;
  mtimeMs: number;
  analysisMode: AnalysisMode;
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
  calls: IndexedCallSite[];
  entrypointSignals: string[];
}

export interface ProjectIndexSkipRecord {
  relativePath: string;
  reason: string;
}

interface ProjectIndexSnapshot {
  version: number;
  rootPath: string;
  builtAt: number;
  files: IndexedProjectFile[];
  skipped: ProjectIndexSkipRecord[];
}

export interface ResolvedImportLink {
  specifier: string;
  importedNames: string[];
  kind: IndexedImportKind;
  targetPath: string;
}

export interface SymbolReference {
  file: IndexedProjectFile;
  symbol: IndexedSymbol;
}

export interface ProjectIndexRuntime {
  rootPath: string;
  builtAt: number;
  cachePath: string;
  files: IndexedProjectFile[];
  skipped: ProjectIndexSkipRecord[];
  byRelativePath: Map<string, IndexedProjectFile>;
  byFileName: Map<string, IndexedProjectFile[]>;
  symbolLookup: Map<string, SymbolReference[]>;
  resolvedImportsByFile: Map<string, ResolvedImportLink[]>;
  dependentsByFile: Map<string, Set<string>>;
  callRelatedFilesByFile: Map<string, Set<string>>;
  entrypointFiles: IndexedProjectFile[];
  stats: {
    reusedFiles: number;
    refreshedFiles: number;
    skippedFiles: number;
    unresolvedLocalImportCount: number;
    basicAnalysisFiles: number;
  };
}

type ScannedProjectFile = {
  fullPath: string;
  relativePath: string;
  fileNameLower: string;
  extension: string;
  language: string;
  sizeBytes: number;
  mtimeMs: number;
};

const APP_NAME = 'odradek-cli';
const SNAPSHOT_VERSION = 1;
const MAX_FILE_SIZE_BYTES = 512_000;
const RUNTIME_CACHE_TTL_MS = 5_000;
const MAX_CALL_TARGETS_PER_NAME = 4;

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.idea',
  '.vscode',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
]);

const TEXT_FILE_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'justfile',
  '.env',
  '.env.example',
  '.gitignore',
  '.npmrc',
  '.yarnrc',
  '.editorconfig',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.py',
  '.java',
  '.kt',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.swift',
  '.cs',
  '.cpp',
  '.cc',
  '.c',
  '.h',
  '.hpp',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.graphql',
  '.proto',
  '.dart',
  '.vue',
  '.svelte',
]);

const TS_LIKE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PRIORITY_ENTRY_FILES = new Set([
  'package.json',
  'readme.md',
  'src/index.ts',
  'src/main.ts',
  'src/app.ts',
  'src/cli/cli.ts',
]);

export class PersistentProjectIndex {
  private readonly runtimeCache = new Map<string, { loadedAt: number; runtime: ProjectIndexRuntime }>();

  async load(rootPath: string): Promise<ProjectIndexRuntime> {
    const normalizedRoot = path.resolve(rootPath);
    const now = Date.now();
    const cached = this.runtimeCache.get(normalizedRoot);
    if (cached && now - cached.loadedAt < RUNTIME_CACHE_TTL_MS) {
      return cached.runtime;
    }

    const cachePath = this.resolveCachePath(normalizedRoot);
    const previous = await this.readSnapshot(cachePath, normalizedRoot);
    const previousByPath = new Map(
      (previous?.files ?? []).map((file) => [file.relativePath.toLowerCase(), file] as const)
    );

    const { files: scannedFiles, skipped } = await this.collectProjectFiles(normalizedRoot);
    const indexedFiles: IndexedProjectFile[] = [];
    let reusedFiles = 0;
    let refreshedFiles = 0;

    for (const scannedFile of scannedFiles) {
      const previousFile = previousByPath.get(scannedFile.relativePath.toLowerCase());
      if (
        previousFile &&
        previousFile.mtimeMs === scannedFile.mtimeMs &&
        previousFile.sizeBytes === scannedFile.sizeBytes
      ) {
        indexedFiles.push(previousFile);
        reusedFiles += 1;
        continue;
      }

      const analyzed = await this.analyzeProjectFile(scannedFile);
      if (!analyzed) {
        skipped.push({ relativePath: scannedFile.relativePath, reason: 'unreadable-or-binary' });
        continue;
      }

      indexedFiles.push(analyzed);
      refreshedFiles += 1;
    }

    indexedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    skipped.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.reason.localeCompare(b.reason));

    const snapshot: ProjectIndexSnapshot = {
      version: SNAPSHOT_VERSION,
      rootPath: normalizedRoot,
      builtAt: now,
      files: indexedFiles,
      skipped,
    };

    await this.writeSnapshot(cachePath, snapshot);
    const runtime = this.createRuntime(snapshot, cachePath, reusedFiles, refreshedFiles);
    this.runtimeCache.set(normalizedRoot, { loadedAt: now, runtime });
    return runtime;
  }

  private async collectProjectFiles(rootPath: string): Promise<{
    files: ScannedProjectFile[];
    skipped: ProjectIndexSkipRecord[];
  }> {
    const stack: string[] = [rootPath];
    const files: ScannedProjectFile[] = [];
    const skipped: ProjectIndexSkipRecord[] = [];

    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) {
        continue;
      }

      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
            continue;
          }
          stack.push(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        const fileNameLower = entry.name.toLowerCase();
        if (!this.isLikelyTextFile(fileNameLower, extension)) {
          continue;
        }
        if (fileNameLower.includes('.min.') && (extension === '.js' || extension === '.css')) {
          continue;
        }

        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }

        const relativePath = this.normalizePath(path.relative(rootPath, fullPath));
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          skipped.push({
            relativePath,
            reason: `file-too-large:${stat.size}`,
          });
          continue;
        }

        files.push({
          fullPath,
          relativePath,
          fileNameLower,
          extension,
          language: this.extensionToLang(extension),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files, skipped };
  }

  private async analyzeProjectFile(scannedFile: ScannedProjectFile): Promise<IndexedProjectFile | null> {
    let content: string;
    try {
      content = await fs.readFile(scannedFile.fullPath, 'utf8');
    } catch {
      return null;
    }

    if (content.includes('\u0000')) {
      return null;
    }

    let analysisMode: AnalysisMode = 'text';
    let symbols: IndexedSymbol[] = [];
    let imports: IndexedImport[] = [];
    let calls: IndexedCallSite[] = [];

    if (TS_LIKE_EXTENSIONS.has(scannedFile.extension)) {
      try {
        const analyzed = this.analyzeWithTypeScript(scannedFile.relativePath, scannedFile.extension, content);
        analysisMode = 'ast';
        symbols = analyzed.symbols;
        imports = analyzed.imports;
        calls = analyzed.calls;
      } catch {
        const analyzed = this.analyzeWithText(scannedFile.relativePath, content);
        symbols = analyzed.symbols;
        imports = analyzed.imports;
        calls = analyzed.calls;
      }
    } else {
      const analyzed = this.analyzeWithText(scannedFile.relativePath, content);
      symbols = analyzed.symbols;
      imports = analyzed.imports;
      calls = analyzed.calls;
    }

    return {
      relativePath: scannedFile.relativePath,
      fileNameLower: scannedFile.fileNameLower,
      extension: scannedFile.extension,
      language: scannedFile.language,
      sizeBytes: scannedFile.sizeBytes,
      mtimeMs: scannedFile.mtimeMs,
      analysisMode,
      symbols,
      imports,
      calls,
      entrypointSignals: this.inferEntrypointSignals(scannedFile.relativePath, content),
    };
  }

  private createRuntime(
    snapshot: ProjectIndexSnapshot,
    cachePath: string,
    reusedFiles: number,
    refreshedFiles: number
  ): ProjectIndexRuntime {
    const byRelativePath = new Map<string, IndexedProjectFile>();
    const byFileName = new Map<string, IndexedProjectFile[]>();
    const symbolLookup = new Map<string, SymbolReference[]>();

    for (const file of snapshot.files) {
      byRelativePath.set(file.relativePath.toLowerCase(), file);
      const fileNameBucket = byFileName.get(file.fileNameLower) ?? [];
      fileNameBucket.push(file);
      byFileName.set(file.fileNameLower, fileNameBucket);

      for (const symbol of file.symbols) {
        for (const searchName of symbol.searchNames) {
          const key = searchName.toLowerCase();
          const bucket = symbolLookup.get(key) ?? [];
          bucket.push({ file, symbol });
          symbolLookup.set(key, bucket);
        }
      }
    }

    const resolvedImportsByFile = new Map<string, ResolvedImportLink[]>();
    const dependentsByFile = new Map<string, Set<string>>();
    let unresolvedLocalImportCount = 0;

    for (const file of snapshot.files) {
      const resolved: ResolvedImportLink[] = [];
      for (const importEntry of file.imports) {
        const targetPath = this.resolveImportSpecifierToPath(
          snapshot.rootPath,
          file.relativePath,
          importEntry.specifier,
          byRelativePath
        );
        if (!targetPath) {
          if (this.looksLocalSpecifier(importEntry.specifier)) {
            unresolvedLocalImportCount += 1;
          }
          continue;
        }

        resolved.push({
          specifier: importEntry.specifier,
          importedNames: [...importEntry.importedNames],
          kind: importEntry.kind,
          targetPath,
        });

        const dependents = dependentsByFile.get(targetPath) ?? new Set<string>();
        dependents.add(file.relativePath);
        dependentsByFile.set(targetPath, dependents);
      }
      resolvedImportsByFile.set(file.relativePath, resolved);
    }

    const callRelatedFilesByFile = new Map<string, Set<string>>();
    for (const file of snapshot.files) {
      const related = new Set<string>();
      for (const callSite of file.calls) {
        const matchedSymbols = symbolLookup.get(callSite.calleeName.toLowerCase()) ?? [];
        const uniqueFiles = Array.from(new Set(matchedSymbols.map((item) => item.file.relativePath))).filter(
          (candidatePath) => candidatePath !== file.relativePath
        );
        if (uniqueFiles.length === 0 || uniqueFiles.length > MAX_CALL_TARGETS_PER_NAME) {
          continue;
        }
        uniqueFiles.forEach((candidatePath) => related.add(candidatePath));
      }
      if (related.size > 0) {
        callRelatedFilesByFile.set(file.relativePath, related);
      }
    }

    const entrypointFiles = snapshot.files
      .filter((file) => file.entrypointSignals.length > 0 || this.shouldTreatAsPriority(file.relativePath))
      .sort((a, b) => {
        return (
          b.entrypointSignals.length - a.entrypointSignals.length ||
          a.relativePath.localeCompare(b.relativePath)
        );
      });

    return {
      rootPath: snapshot.rootPath,
      builtAt: snapshot.builtAt,
      cachePath,
      files: snapshot.files,
      skipped: snapshot.skipped,
      byRelativePath,
      byFileName,
      symbolLookup,
      resolvedImportsByFile,
      dependentsByFile,
      callRelatedFilesByFile,
      entrypointFiles,
      stats: {
        reusedFiles,
        refreshedFiles,
        skippedFiles: snapshot.skipped.length,
        unresolvedLocalImportCount,
        basicAnalysisFiles: snapshot.files.filter((file) => file.analysisMode === 'text').length,
      },
    };
  }

  private analyzeWithTypeScript(
    relativePath: string,
    extension: string,
    content: string
  ): {
    symbols: IndexedSymbol[];
    imports: IndexedImport[];
    calls: IndexedCallSite[];
  } {
    const sourceFile = ts.createSourceFile(
      relativePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      this.toScriptKind(extension)
    );

    const symbols: IndexedSymbol[] = [];
    const imports: IndexedImport[] = [];
    const calls: IndexedCallSite[] = [];
    const seenSymbolIds = new Set<string>();
    const seenImports = new Set<string>();
    const seenCalls = new Set<string>();

    const visit = (node: ts.Node, currentSymbol: IndexedSymbol | null, currentClassName: string | null): void => {
      this.maybeCollectModuleReference(node, imports, seenImports);

      const createdSymbol = this.maybeCreateSymbol(relativePath, sourceFile, node, currentClassName);
      let nextSymbol = currentSymbol;
      let nextClassName = currentClassName;

      if (createdSymbol) {
        if (!seenSymbolIds.has(createdSymbol.id)) {
          seenSymbolIds.add(createdSymbol.id);
          symbols.push(createdSymbol);
        }
        nextSymbol = createdSymbol;
        if (createdSymbol.kind === 'class') {
          nextClassName = createdSymbol.shortName;
        }
      }

      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && currentSymbol) {
        const expression = node.expression;
        const calleeNames = this.extractCallNames(expression);
        for (const calleeName of calleeNames) {
          const key = `${currentSymbol.id}::${calleeName}`;
          if (seenCalls.has(key)) {
            continue;
          }
          seenCalls.add(key);
          calls.push({
            callerSymbolId: currentSymbol.id,
            callerName: currentSymbol.name,
            calleeName,
            expression: expression.getText(sourceFile).slice(0, 160),
          });
        }
      }

      ts.forEachChild(node, (child) => visit(child, nextSymbol, nextClassName));
    };

    visit(sourceFile, null, null);

    symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    imports.sort((a, b) => a.specifier.localeCompare(b.specifier) || a.kind.localeCompare(b.kind));
    calls.sort((a, b) => a.callerName.localeCompare(b.callerName) || a.calleeName.localeCompare(b.calleeName));

    return { symbols, imports, calls };
  }

  private analyzeWithText(
    relativePath: string,
    content: string
  ): {
    symbols: IndexedSymbol[];
    imports: IndexedImport[];
    calls: IndexedCallSite[];
  } {
    const imports = this.extractImportSpecifiers(content).map((specifier) => ({
      specifier,
      importedNames: [] as string[],
      kind: 'import' as const,
    }));

    const symbols: IndexedSymbol[] = [];
    const seen = new Set<string>();
    const textPatterns: Array<{ regex: RegExp; kind: IndexedSymbolKind }> = [
      { regex: /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'class' },
      { regex: /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'function' },
      { regex: /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'interface' },
      { regex: /\btype\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'type' },
      { regex: /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'enum' },
      { regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/gm, kind: 'function' },
      { regex: /^\s*fn\s+([A-Za-z_][A-Za-z0-9_]*)/gm, kind: 'function' },
      { regex: /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)/gm, kind: 'function' },
    ];

    for (const pattern of textPatterns) {
      let match = pattern.regex.exec(content);
      while (match) {
        const name = match[1]?.trim();
        if (name) {
          const line = this.getLineNumber(content, match.index ?? 0);
          const id = `${relativePath}::${pattern.kind}:${name}@${line}`;
          if (!seen.has(id)) {
            seen.add(id);
            symbols.push({
              id,
              name,
              shortName: name,
              searchNames: [name.toLowerCase()],
              kind: pattern.kind,
              line,
              exported: false,
            });
          }
        }
        match = pattern.regex.exec(content);
      }
    }

    symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    return { symbols, imports, calls: [] };
  }

  private maybeCollectModuleReference(
    node: ts.Node,
    imports: IndexedImport[],
    seenImports: Set<string>
  ): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const importClause = node.importClause;
      const importedNames: string[] = [];
      if (importClause?.name) {
        importedNames.push(importClause.name.text);
      }
      if (importClause?.namedBindings) {
        if (ts.isNamedImports(importClause.namedBindings)) {
          importClause.namedBindings.elements.forEach((element) => {
            importedNames.push(element.name.text);
          });
        } else if (ts.isNamespaceImport(importClause.namedBindings)) {
          importedNames.push(importClause.namedBindings.name.text);
        }
      }
      this.pushImportRecord(imports, seenImports, {
        specifier: node.moduleSpecifier.text,
        importedNames,
        kind: 'import',
      });
      return;
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      this.pushImportRecord(imports, seenImports, {
        specifier: node.moduleSpecifier.text,
        importedNames: [],
        kind: 'export-from',
      });
      return;
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      node.initializer.arguments.length > 0 &&
      ts.isStringLiteralLike(node.initializer.arguments[0])
    ) {
      this.pushImportRecord(imports, seenImports, {
        specifier: node.initializer.arguments[0].text,
        importedNames: this.extractBindingNames(node.name),
        kind: 'require',
      });
      return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      this.pushImportRecord(imports, seenImports, {
        specifier: node.arguments[0].text,
        importedNames: [],
        kind: 'require',
      });
    }
  }

  private pushImportRecord(imports: IndexedImport[], seenImports: Set<string>, record: IndexedImport): void {
    const dedupedNames = Array.from(new Set(record.importedNames.filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const key = `${record.kind}::${record.specifier}::${dedupedNames.join(',')}`;
    if (seenImports.has(key)) {
      return;
    }
    seenImports.add(key);
    imports.push({
      specifier: record.specifier,
      importedNames: dedupedNames,
      kind: record.kind,
    });
  }

  private maybeCreateSymbol(
    relativePath: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    currentClassName: string | null
  ): IndexedSymbol | null {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return this.createIndexedSymbol(relativePath, sourceFile, node, 'function', node.name.text, false, currentClassName);
    }

    if (ts.isClassDeclaration(node) && node.name) {
      return this.createIndexedSymbol(relativePath, sourceFile, node, 'class', node.name.text, false, currentClassName);
    }

    if (ts.isInterfaceDeclaration(node)) {
      return this.createIndexedSymbol(relativePath, sourceFile, node, 'interface', node.name.text, false, currentClassName);
    }

    if (ts.isTypeAliasDeclaration(node)) {
      return this.createIndexedSymbol(relativePath, sourceFile, node, 'type', node.name.text, false, currentClassName);
    }

    if (ts.isEnumDeclaration(node)) {
      return this.createIndexedSymbol(relativePath, sourceFile, node, 'enum', node.name.text, false, currentClassName);
    }

    if (ts.isMethodDeclaration(node)) {
      const methodName = this.getPropertyNameText(node.name);
      if (!methodName) {
        return null;
      }
      return this.createIndexedSymbol(relativePath, sourceFile, node, 'method', methodName, true, currentClassName);
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      return this.createIndexedSymbol(relativePath, sourceFile, node, 'function', node.name.text, false, currentClassName);
    }

    return null;
  }

  private createIndexedSymbol(
    relativePath: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    kind: IndexedSymbolKind,
    baseName: string,
    allowParentPrefix: boolean,
    currentClassName: string | null
  ): IndexedSymbol {
    const parentName = allowParentPrefix ? currentClassName ?? undefined : undefined;
    const shortName = baseName;
    const fullName = parentName ? `${parentName}.${baseName}` : baseName;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const searchNames = Array.from(
      new Set(
        [fullName, shortName, parentName ? `${parentName}#${baseName}` : '']
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      )
    );

    return {
      id: `${relativePath}::${kind}:${fullName}@${line}`,
      name: fullName,
      shortName,
      searchNames,
      kind,
      line,
      exported: this.isNodeExported(node),
      parentName,
    };
  }

  private isNodeExported(node: ts.Node): boolean {
    if (this.hasExportModifier(node)) {
      return true;
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent)
    ) {
      return this.hasExportModifier(node.parent.parent);
    }

    return false;
  }

  private hasExportModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(
      modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
      )
    );
  }

  private extractBindingNames(name: ts.BindingName): string[] {
    if (ts.isIdentifier(name)) {
      return [name.text];
    }

    const names: string[] = [];
    for (const element of name.elements) {
      if (!ts.isBindingElement(element)) {
        continue;
      }
      names.push(...this.extractBindingNames(element.name));
    }
    return names;
  }

  private extractCallNames(expression: ts.LeftHandSideExpression | ts.Expression | undefined): string[] {
    if (!expression) {
      return [];
    }

    const names = new Set<string>();
    const visit = (target: ts.Expression): void => {
      if (ts.isIdentifier(target)) {
        names.add(target.text);
        return;
      }

      if (ts.isPropertyAccessExpression(target)) {
        names.add(target.name.text);
        const chain = this.getPropertyAccessChain(target);
        if (chain) {
          names.add(chain);
        }
        return;
      }

      if (ts.isCallExpression(target)) {
        visit(target.expression);
        return;
      }

      if (ts.isParenthesizedExpression(target)) {
        visit(target.expression);
      }
    };

    visit(expression);
    return Array.from(names);
  }

  private getPropertyAccessChain(expression: ts.PropertyAccessExpression): string {
    const parts: string[] = [expression.name.text];
    let current: ts.Expression = expression.expression;

    while (true) {
      if (ts.isIdentifier(current)) {
        parts.unshift(current.text);
        break;
      }

      if (ts.isPropertyAccessExpression(current)) {
        parts.unshift(current.name.text);
        current = current.expression;
        continue;
      }

      if (current.kind === ts.SyntaxKind.ThisKeyword) {
        parts.unshift('this');
      }
      break;
    }

    return parts.join('.');
  }

  private getPropertyNameText(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return null;
  }

  private extractImportSpecifiers(content: string): string[] {
    const firstChunk = content.slice(0, 24_000);
    const patterns = [
      /\bimport\s+[^'"\n]*?\s+from\s+['"]([^'"]+)['"]/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bexport\s+[^'"\n]*?\s+from\s+['"]([^'"]+)['"]/g,
    ];

    const result = new Set<string>();
    for (const pattern of patterns) {
      let match = pattern.exec(firstChunk);
      while (match) {
        const specifier = match[1]?.trim();
        if (specifier) {
          result.add(specifier);
        }
        match = pattern.exec(firstChunk);
      }
    }
    return Array.from(result);
  }

  private resolveImportSpecifierToPath(
    rootPath: string,
    sourceRelativePath: string,
    specifier: string,
    byRelativePath: Map<string, IndexedProjectFile>
  ): string | null {
    const normalizedSpecifier = specifier.trim().replace(/\\/g, '/');
    if (!normalizedSpecifier) {
      return null;
    }

    const lookupPaths: string[] = [];
    const rawExt = path.extname(normalizedSpecifier).toLowerCase();
    const maybePush = (candidateRelative: string): void => {
      const normalized = this.normalizePath(candidateRelative).replace(/^\.\/+/, '');
      lookupPaths.push(normalized);
    };
    const pushExtensionVariants = (candidateRelative: string): void => {
      const withoutExt = rawExt ? candidateRelative.slice(0, -rawExt.length) : candidateRelative;
      for (const extension of ALLOWED_EXTENSIONS) {
        maybePush(`${withoutExt}${extension}`);
      }
    };

    if (normalizedSpecifier.startsWith('.')) {
      const sourceDir = path.dirname(path.join(rootPath, sourceRelativePath));
      const absolute = path.resolve(sourceDir, normalizedSpecifier);
      const relative = this.normalizePath(path.relative(rootPath, absolute));
      maybePush(relative);
      if (!rawExt) {
        for (const extension of ALLOWED_EXTENSIONS) {
          maybePush(`${relative}${extension}`);
          maybePush(`${relative}/index${extension}`);
        }
      } else {
        pushExtensionVariants(relative);
      }
    } else if (normalizedSpecifier.startsWith('@/') || normalizedSpecifier.startsWith('~/')) {
      const relative = normalizedSpecifier.slice(2);
      maybePush(relative);
      if (!rawExt) {
        for (const extension of ALLOWED_EXTENSIONS) {
          maybePush(`${relative}${extension}`);
          maybePush(`${relative}/index${extension}`);
        }
      } else {
        pushExtensionVariants(relative);
      }
    } else if (normalizedSpecifier.startsWith('/')) {
      maybePush(normalizedSpecifier.slice(1));
    } else if (normalizedSpecifier.includes('/')) {
      maybePush(normalizedSpecifier);
      if (!rawExt) {
        for (const extension of ALLOWED_EXTENSIONS) {
          maybePush(`${normalizedSpecifier}${extension}`);
          maybePush(`${normalizedSpecifier}/index${extension}`);
        }
      } else {
        pushExtensionVariants(normalizedSpecifier);
      }
    }

    for (const candidate of lookupPaths) {
      if (byRelativePath.has(candidate.toLowerCase())) {
        return candidate;
      }
    }

    return null;
  }

  private looksLocalSpecifier(specifier: string): boolean {
    const normalized = specifier.trim();
    return (
      normalized.startsWith('.') ||
      normalized.startsWith('@/') ||
      normalized.startsWith('~/') ||
      normalized.startsWith('/') ||
      normalized.startsWith('src/')
    );
  }

  private inferEntrypointSignals(relativePath: string, content: string): string[] {
    const signals = new Set<string>();
    const lowerPath = relativePath.toLowerCase();
    const baseName = path.posix.basename(lowerPath);

    if (this.shouldTreatAsPriority(relativePath)) {
      signals.add('priority-file');
    }

    if (lowerPath.startsWith('bin/') || lowerPath.includes('/bin/')) {
      signals.add('bin-directory');
    }

    if (content.startsWith('#!')) {
      signals.add('shebang');
    }

    if (
      (baseName.includes('cli') || baseName.startsWith('index.')) &&
      /\b(process\.argv|commander|readline|inquirer)\b/.test(content)
    ) {
      signals.add('cli-runtime');
    }

    if (/\bcreateServer\s*\(|\.listen\s*\(/.test(content)) {
      signals.add('server-bootstrap');
    }

    if (/\bReactDOM\.createRoot\b|\bcreateRoot\s*\(/.test(content)) {
      signals.add('ui-bootstrap');
    }

    if (/\bmain\s*\(/.test(content) && baseName.startsWith('index.')) {
      signals.add('main-function');
    }

    if (lowerPath === 'package.json') {
      signals.add('package-manifest');
    }

    return Array.from(signals).sort((a, b) => a.localeCompare(b));
  }

  private shouldTreatAsPriority(relativePath: string): boolean {
    const lower = relativePath.toLowerCase();
    return (
      PRIORITY_ENTRY_FILES.has(lower) ||
      lower.endsWith('/readme.md') ||
      lower.endsWith('/package.json') ||
      lower.endsWith('/src/index.ts')
    );
  }

  private toScriptKind(extension: string): ts.ScriptKind {
    switch (extension) {
      case '.ts':
        return ts.ScriptKind.TS;
      case '.tsx':
        return ts.ScriptKind.TSX;
      case '.jsx':
        return ts.ScriptKind.JSX;
      case '.js':
      case '.mjs':
      case '.cjs':
        return ts.ScriptKind.JS;
      default:
        return ts.ScriptKind.Unknown;
    }
  }

  private getLineNumber(content: string, index: number): number {
    return content.slice(0, index).split(/\r?\n/).length;
  }

  private normalizePath(inputPath: string): string {
    return inputPath.split(path.sep).join('/');
  }

  private isLikelyTextFile(fileNameLower: string, extension: string): boolean {
    if (ALLOWED_EXTENSIONS.has(extension)) {
      return true;
    }
    if (TEXT_FILE_BASENAMES.has(fileNameLower)) {
      return true;
    }
    return extension === '' && (fileNameLower.includes('readme') || fileNameLower.includes('license'));
  }

  private extensionToLang(extension: string): string {
    if (!extension) {
      return 'plain';
    }

    const map: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.json': 'json',
      '.md': 'markdown',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.php': 'php',
      '.rb': 'ruby',
      '.cs': 'csharp',
      '.cpp': 'cpp',
      '.c': 'c',
      '.sql': 'sql',
      '.yml': 'yaml',
      '.yaml': 'yaml',
      '.toml': 'toml',
      '.sh': 'shell',
      '.ps1': 'powershell',
      '.vue': 'vue',
    };

    return map[extension] ?? extension.slice(1);
  }

  private async readSnapshot(cachePath: string, rootPath: string): Promise<ProjectIndexSnapshot | null> {
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw) as ProjectIndexSnapshot;
      if (parsed.version !== SNAPSHOT_VERSION || path.resolve(parsed.rootPath) !== path.resolve(rootPath)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeSnapshot(cachePath: string, snapshot: ProjectIndexSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  private resolveCachePath(rootPath: string, appName: string = APP_NAME): string {
    const hashedRoot = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
    const baseName = path.basename(rootPath).replace(/[^a-z0-9_-]+/gi, '_') || 'project';
    return path.join(this.getStorageDir(appName), 'project-indexes', `${baseName}-${hashedRoot}.json`);
  }

  private getStorageDir(appName: string = APP_NAME): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        return path.join(appData, appName);
      }
      return path.join(home, 'AppData', 'Roaming', appName);
    }

    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', appName);
    }

    return path.join(home, '.config', appName);
  }
}
