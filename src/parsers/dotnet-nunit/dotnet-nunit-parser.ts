import * as path from 'path'
import {ParseOptions, TestParser} from '../../test-parser'
import {parseStringPromise} from 'xml2js'

import {NunitReport, TestCase, TestSuite} from './dotnet-nunit-types'
import {normalizeFilePath} from '../../utils/path-utils'

import {
  TestExecutionResult,
  TestRunResult,
  TestSuiteResult,
  TestGroupResult,
  TestCaseResult,
  TestCaseError
} from '../../test-results'

export class DotnetNunitParser implements TestParser {
  readonly trackedFiles: {[fileName: string]: string[]}

  constructor(readonly options: ParseOptions) {
    this.trackedFiles = {}
    for (const filePath of options.trackedFiles) {
      const fileName = path.basename(filePath)
      const files = this.trackedFiles[fileName] ?? (this.trackedFiles[fileName] = [])
      files.push(normalizeFilePath(filePath))
    }
  }

  async parse(filePath: string, content: string): Promise<TestRunResult> {
    const reportOrSuite = await this.getNunitReport(filePath, content)
    return this.getTestRunResult(filePath, reportOrSuite)
  }

  private async getNunitReport(filePath: string, content: string): Promise<NunitReport> {
    try {
      return await parseStringPromise(content)
    } catch (e) {
      throw new Error(`Invalid XML at ${filePath}\n\n${e}`)
    }
  }

  private getTestSuiteResultRecursive(
    testSuites: TestSuite[] | undefined,
    suiteResults: TestSuiteResult[],
    depth: number
  ): void {
    if (testSuites !== undefined) {
      testSuites.map(ts => {
        const name = ts.$.name.trim()
        const time = parseFloat(ts.$.duration) * 1000
        const groups = this.getGroups(ts)
        const sr = new TestSuiteResult(name, groups, time, depth)
        suiteResults.push(sr)

        if (groups.length === 0) {
          const nestedTestSuites = ts['test-suite']
          if (nestedTestSuites !== undefined) {
            this.getTestSuiteResultRecursive(nestedTestSuites, suiteResults, depth + 1)
          }
        }
      })
    }
  }

  private getTestRunResult(filePath: string, nunit: NunitReport): TestRunResult {
    const suites: TestSuiteResult[] = []

    const testSuites = nunit['test-run']['test-suite']
    this.getTestSuiteResultRecursive(testSuites, suites, 0)

    const seconds = parseFloat(nunit['test-run'].$?.time)
    const time = isNaN(seconds) ? undefined : seconds * 1000
    return new TestRunResult(filePath, suites, time)
  }

  private getGroups(suite: TestSuite): TestGroupResult[] {
    const groups: {describe: string; tests: TestCase[]}[] = []
    if (suite['test-case'] === undefined) {
      return []
    }
    for (const tc of suite['test-case']) {
      let grp = groups.find(g => g.describe === tc.$.classname)
      if (grp === undefined) {
        grp = {describe: tc.$.classname, tests: []}
        groups.push(grp)
      }
      grp.tests.push(tc)
    }

    return groups.map(grp => {
      const tests = grp.tests.map(tc => {
        const name = tc.$.name.trim()
        const result = this.getTestCaseResult(tc)
        const time = parseFloat(tc.$.duration) * 1000
        return new TestCaseResult(name, result, time, undefined)
      })
      return new TestGroupResult(grp.describe, tests)
    })
  }

  private getTestCaseResult(test: TestCase): TestExecutionResult {
    if (test.failure) return 'failed'
    if (test.$.result === 'Skipped') return 'skipped'
    return 'success'
  }

  private getTestCaseError(tc: TestCase): TestCaseError | undefined {
    if (!this.options.parseErrors) {
      return undefined
    }

    // We process <error> and <failure> the same way
    const failure = tc.failure
    if (!failure) {
      return undefined
    }

    const details = typeof failure === 'object' ? failure['stack-trace'] : failure
    let filePath
    let line

    const src = this.exceptionThrowSource(details)
    if (src) {
      filePath = src.filePath
      line = src.line
    }

    return {
      path: filePath,
      line,
      details,
      message: typeof failure === 'object' ? failure.message : undefined
    }
  }

  private exceptionThrowSource(stackTrace: string): {filePath: string; line: number} | undefined {
    const lines = stackTrace.split(/\r?\n/)
    const re = /^at (.*)\((.*):(\d+)\)$/

    for (const str of lines) {
      const match = str.match(re)
      if (match !== null) {
        const [_, tracePath, fileName, lineStr] = match
        const filePath = this.getFilePath(tracePath, fileName)
        if (filePath !== undefined) {
          const line = parseInt(lineStr)
          return {filePath, line}
        }
      }
    }
  }

  // Stacktrace in Java doesn't contain full paths to source file.
  // There are only package, file name and line.
  // Assuming folder structure matches package name (as it should in Java),
  // we can try to match tracked file.
  private getFilePath(tracePath: string, fileName: string): string | undefined {
    // Check if there is any tracked file with given name
    const files = this.trackedFiles[fileName]
    if (files === undefined) {
      return undefined
    }

    // Remove class name and method name from trace.
    // Take parts until first item with capital letter - package names are lowercase while class name is CamelCase.
    const packageParts = tracePath.split(/\./g)
    const packageIndex = packageParts.findIndex(part => part[0] <= 'Z')
    if (packageIndex !== -1) {
      packageParts.splice(packageIndex, packageParts.length - packageIndex)
    }

    if (packageParts.length === 0) {
      return undefined
    }

    // Get right file
    // - file name matches
    // - parent folders structure must reflect the package name
    for (const filePath of files) {
      const dirs = path.dirname(filePath).split(/\//g)
      if (packageParts.length > dirs.length) {
        continue
      }
      // get only N parent folders, where N = length of package name parts
      if (dirs.length > packageParts.length) {
        dirs.splice(0, dirs.length - packageParts.length)
      }
      // check if parent folder structure matches package name
      const isMatch = packageParts.every((part, i) => part === dirs[i])
      if (isMatch) {
        return filePath
      }
    }

    return undefined
  }
}
