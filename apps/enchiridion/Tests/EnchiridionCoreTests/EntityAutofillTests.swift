import XCTest
@testable import EnchiridionCore

final class EntityAutofillTests: XCTestCase {
  func testModelInputContainsOnlySelectedSchemaAndExactUserDetails() throws {
    let schema = makeSchema()
    let details = "  Jamie works at Acme.  "

    let input = EntityAutofillModelInput(
      request: EntityAutofillRequest(schema: schema, userProvidedDetails: details)
    )

    XCTAssertEqual(input.schemaID, schema.id.rawValue)
    XCTAssertEqual(input.schemaName, "Person")
    XCTAssertEqual(input.userProvidedDetails, details)
    XCTAssertEqual(input.fields.map(\.id), ["email", "role", "status"])
    XCTAssertEqual(input.fields.map(\.supertagID), [schema.id.rawValue, schema.id.rawValue, schema.id.rawValue])
    XCTAssertFalse(input.fields.contains { $0.id == "organization" })
    let prompt = EntityAutofillPromptSerializer.serialize(input)
    XCTAssertTrue(prompt.contains(details))
    XCTAssertFalse(prompt.contains("organization"))
  }

  func testValidatorRejectsUnknownReferenceInvalidScalarAndInvalidSelectValues() {
    let schema = makeSchema()
    let unknown = SupertagPropertyKey(supertagID: schema.id, fieldID: .init(rawValue: "unknown"))
    let organization = SupertagPropertyKey(
      supertagID: schema.id,
      fieldID: .init(rawValue: "organization")
    )
    let email = SupertagPropertyKey(supertagID: schema.id, fieldID: .init(rawValue: "email"))
    let status = SupertagPropertyKey(supertagID: schema.id, fieldID: .init(rawValue: "status"))

    XCTAssertThrowsError(
      try EntityAutofillProposalValidator.validate(
        .init(properties: [unknown: [.text("value")]]), for: schema
      )
    ) { XCTAssertEqual($0 as? EntityAutofillValidationError, .unknownField) }
    XCTAssertThrowsError(
      try EntityAutofillProposalValidator.validate(
        .init(properties: [organization: [.page(.free())]]), for: schema
      )
    ) { XCTAssertEqual($0 as? EntityAutofillValidationError, .entityReference) }
    XCTAssertThrowsError(
      try EntityAutofillProposalValidator.validate(
        .init(properties: [email: [.email("not-an-email")]]), for: schema
      )
    ) { XCTAssertEqual($0 as? EntityAutofillValidationError, .invalidValue) }
    XCTAssertThrowsError(
      try EntityAutofillProposalValidator.validate(
        .init(properties: [status: [.select("invented")]]), for: schema
      )
    ) { XCTAssertEqual($0 as? EntityAutofillValidationError, .invalidValue) }
  }

  func testValidatorNormalizesSchemaValidScalarProposal() throws {
    let schema = makeSchema()
    let email = SupertagPropertyKey(supertagID: schema.id, fieldID: .init(rawValue: "email"))
    let status = SupertagPropertyKey(supertagID: schema.id, fieldID: .init(rawValue: "status"))
    let proposal = try EntityAutofillProposalValidator.validate(
      .init(
        title: "  Jamie Doe  ",
        properties: [
          email: [.email(" Jamie@Example.com ")],
          status: [.select("active")],
        ]
      ),
      for: schema
    )

    XCTAssertEqual(proposal.title, "Jamie Doe")
    XCTAssertEqual(proposal.properties[email], [.email("jamie@example.com")])
    XCTAssertEqual(proposal.properties[status], [.select("active")])
  }

  func testEffectiveFieldsRetainOwnersAndResolveParentsBeforeSubtype() throws {
    let person = makeSchema()
    let employee = SupertagDefinition(
      id: .init(rawValue: "employee"),
      name: "Employee",
      symbol: "briefcase",
      fields: [
        .init(id: .init(rawValue: "email"), name: "Work email", type: .email),
        .init(id: .init(rawValue: "employeeID"), name: "Employee ID", type: .text),
      ],
      parentIDs: [person.id]
    )

    let effectiveFields = SupertagInheritance.effectiveFields(
      for: employee.id,
      definitions: [person, employee]
    )

    XCTAssertEqual(
      effectiveFields.map(\.propertyKey),
      [
        .init(supertagID: person.id, fieldID: .init(rawValue: "email")),
        .init(supertagID: person.id, fieldID: .init(rawValue: "role")),
        .init(supertagID: person.id, fieldID: .init(rawValue: "status")),
        .init(supertagID: person.id, fieldID: .init(rawValue: "organization")),
        .init(supertagID: employee.id, fieldID: .init(rawValue: "email")),
        .init(supertagID: employee.id, fieldID: .init(rawValue: "employeeID")),
      ]
    )
    XCTAssertNotEqual(effectiveFields[0], effectiveFields[4])
  }

  func testEffectiveFieldsSkipDeletedSchemasAndTerminateCyclesWithoutRepeatingFields() throws {
    let root = SupertagDefinition(
      id: .init(rawValue: "root"),
      name: "Root",
      symbol: "circle",
      fields: [.init(id: .init(rawValue: "root"), name: "Root", type: .text)],
      parentIDs: [.init(rawValue: "child")]
    )
    let child = SupertagDefinition(
      id: .init(rawValue: "child"),
      name: "Child",
      symbol: "circle",
      fields: [.init(id: .init(rawValue: "child"), name: "Child", type: .text)],
      parentIDs: [root.id, .init(rawValue: "deleted")]
    )
    let deleted = SupertagDefinition(
      id: .init(rawValue: "deleted"),
      name: "Deleted",
      symbol: "circle",
      fields: [.init(id: .init(rawValue: "deleted"), name: "Deleted", type: .text)],
      isDeleted: true
    )

    let fields = SupertagInheritance.effectiveFields(
      for: child.id,
      definitions: [root, child, deleted]
    )

    XCTAssertEqual(fields.map(\.propertyKey), [
      .init(supertagID: root.id, fieldID: .init(rawValue: "root")),
      .init(supertagID: child.id, fieldID: .init(rawValue: "child")),
    ])
  }

  func testInheritedPersonEmailIsAllowedAndUnrelatedOrReferenceFieldsAreRejected() throws {
    let person = makeSchema()
    let employee = SupertagDefinition(
      id: .init(rawValue: "employee"),
      name: "Employee",
      symbol: "briefcase",
      fields: [],
      parentIDs: [person.id]
    )
    let fields = SupertagInheritance.effectiveFields(for: employee.id, definitions: [person, employee])
    let inheritedEmail = SupertagPropertyKey(supertagID: person.id, fieldID: .init(rawValue: "email"))
    let organization = SupertagPropertyKey(
      supertagID: person.id,
      fieldID: .init(rawValue: "organization")
    )
    let unrelated = SupertagPropertyKey(
      supertagID: .init(rawValue: "unrelated"),
      fieldID: .init(rawValue: "email")
    )

    let proposal = try EntityAutofillProposalValidator.validate(
      .init(properties: [inheritedEmail: [.email("Jamie@Example.com")]]),
      for: employee,
      effectiveFields: fields
    )
    XCTAssertEqual(proposal.properties[inheritedEmail], [.email("jamie@example.com")])
    XCTAssertThrowsError(
      try EntityAutofillProposalValidator.validate(
        .init(properties: [organization: [.page(.free())]]),
        for: employee,
        effectiveFields: fields
      )
    ) { XCTAssertEqual($0 as? EntityAutofillValidationError, .entityReference) }
    XCTAssertThrowsError(
      try EntityAutofillProposalValidator.validate(
        .init(properties: [unrelated: [.email("jamie@example.com")]]),
        for: employee,
        effectiveFields: fields
      )
    ) { XCTAssertEqual($0 as? EntityAutofillValidationError, .crossSchemaField) }
  }

  func testInheritedModelInputIncludesOwningSchemaIDAndOnlyScalarFields() throws {
    let person = makeSchema()
    let employee = SupertagDefinition(
      id: .init(rawValue: "employee"),
      name: "Employee",
      symbol: "briefcase",
      fields: [.init(id: .init(rawValue: "role"), name: "Role", type: .text)],
      parentIDs: [person.id]
    )
    let fields = SupertagInheritance.effectiveFields(for: employee.id, definitions: [person, employee])
    let input = EntityAutofillModelInput(
      request: .init(schema: employee, effectiveFields: fields, userProvidedDetails: "Jamie works at Acme")
    )

    XCTAssertEqual(input.fields.map { "\($0.supertagID).\($0.id)" }, [
      "person.email", "person.role", "person.status", "employee.role",
    ])
    XCTAssertFalse(input.fields.contains { $0.id == "organization" })
  }

  func testUnavailableProviderReturnsExplicitManualPathWithoutGenerating() async {
    let generator = RecordingGenerator(proposal: .init(title: "Should not run"))
    let provider = FoundationModelEntityAutofill(
      availabilityProvider: { _ in .appleIntelligenceNotEnabled },
      generator: generator
    )

    let result = await provider.propose(
      EntityAutofillRequest(schema: makeSchema(), userProvidedDetails: "Jamie Doe")
    )

    XCTAssertEqual(result, .unavailable(.appleIntelligenceNotEnabled))
    let callCount = await generator.callCount()
    XCTAssertEqual(callCount, 0)
  }

  func testInjectedGeneratorReceivesOnlyModelInputAndNoPersistenceOrNetworkDependency() async {
    let schema = makeSchema()
    let generator = RecordingGenerator(
      proposal: .init(
        title: "Jamie Doe",
        properties: [
          .init(supertagID: schema.id, fieldID: .init(rawValue: "role")): [.text("Designer")]
        ]
      )
    )
    let provider = FoundationModelEntityAutofill(
      availabilityProvider: { _ in .available },
      generator: generator
    )
    let details = "Jamie is a designer at Acme."

    let result = await provider.propose(
      EntityAutofillRequest(schema: schema, userProvidedDetails: details)
    )

    guard case .proposal(let proposal) = result else {
      return XCTFail("Expected an editable proposal, got \(result)")
    }
    XCTAssertEqual(proposal.title, "Jamie Doe")
    let inputs = await generator.inputs()
    XCTAssertEqual(inputs.map(\.userProvidedDetails), [details])
    XCTAssertEqual(inputs.first?.schemaID, schema.id.rawValue)
  }

  private func makeSchema() -> SupertagDefinition {
    let id = SupertagID(rawValue: "person")
    return SupertagDefinition(
      id: id,
      name: "Person",
      symbol: "person.crop.circle",
      fields: [
        .init(id: .init(rawValue: "email"), name: "Email", type: .email),
        .init(id: .init(rawValue: "role"), name: "Role", type: .text),
        .init(
          id: .init(rawValue: "status"),
          name: "Status",
          type: .select,
          options: [.init(id: "active", name: "Active")]
        ),
        .init(
          id: .init(rawValue: "organization"),
          name: "Organization",
          type: .entityReference,
          allowedSupertagIDs: [BuiltInSupertags.organization]
        ),
      ]
    )
  }
}

private actor RecordingGenerator: EntityAutofillGenerating {
  private let proposal: EntityAutofillRawProposal
  private var recordedInputs: [EntityAutofillModelInput] = []

  init(proposal: EntityAutofillRawProposal) {
    self.proposal = proposal
  }

  func generate(_ input: EntityAutofillModelInput) async throws -> EntityAutofillRawProposal {
    recordedInputs.append(input)
    return proposal
  }

  func callCount() -> Int { recordedInputs.count }
  func inputs() -> [EntityAutofillModelInput] { recordedInputs }
}
