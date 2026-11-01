import Testing
@testable import OHBPopup

/// Runs a suite with the French copy, the text these tests were written against. Scoped to the
/// suite's task, so suites checking the English default run in parallel without interference.
struct FrenchTrait: SuiteTrait, TestTrait, TestScoping {
    var isRecursive: Bool { true }

    func provideScope(for test: Test, testCase: Test.Case?,
                      performing function: @Sendable () async throws -> Void) async throws {
        try await Language.$override.withValue(.fr) { try await function() }
    }
}

extension Trait where Self == FrenchTrait {
    static var french: Self { FrenchTrait() }
}
