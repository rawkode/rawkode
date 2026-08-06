import * as Option from "effect/Option";
import * as AST from "effect/SchemaAST";
import { openAPISchema } from "./artifacts";
import {
  errorCodes,
  protocolSchemaDefinitions,
  protocolVersion,
  syncFrameSigningPayloadVersion,
  websocketContract,
} from "./contracts";

function unrefined(value: AST.AST): AST.AST {
  let current = value;
  while (AST.isRefinement(current)) current = current.from;
  return current;
}

function swiftType(source: AST.AST): string {
  const value = unrefined(source);
  const identifier = Option.getOrUndefined(AST.getIdentifierAnnotation(source));
  if (identifier !== undefined)
    return AST.isTypeLiteral(value) ? identifier : `Enchiridion${identifier}`;
  if (AST.isStringKeyword(value) || AST.isLiteral(value)) return "String";
  if (AST.isNumberKeyword(value)) return "Int";
  if (AST.isBooleanKeyword(value)) return "Bool";
  if (AST.isTupleType(value))
    return `[${swiftType(value.rest[0] === undefined ? value : value.rest[0].type)}]`;
  if (AST.isUnion(value)) {
    const defined = value.types.filter((type) => !AST.isUndefinedKeyword(type));
    if (defined.length === 1 && defined[0] !== undefined) return swiftType(defined[0]);
  }
  if (AST.isTypeLiteral(value)) return "[String: String]";
  throw new TypeError(`Unsupported Swift schema AST node: ${value._tag}`);
}

function literalValue(source: AST.AST): string | number | boolean | null | undefined {
  if (Option.getOrUndefined(AST.getIdentifierAnnotation(source)) !== undefined) return undefined;
  const value = unrefined(source);
  if (!AST.isLiteral(value)) return undefined;
  return typeof value.literal === "bigint" ? undefined : value.literal;
}

type WireSchema = {
  readonly type?: string;
  readonly const?: string | number | boolean | null;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
};

function wireSchema(ast: AST.AST): WireSchema {
  const projected = openAPISchema({ ast });
  const value = (key: string): unknown =>
    key in projected ? Reflect.get(projected, key) : undefined;
  const string = (key: string): string | undefined => {
    const candidate = value(key);
    return typeof candidate === "string" ? candidate : undefined;
  };
  const number = (key: string): number | undefined => {
    const candidate = value(key);
    return typeof candidate === "number" ? candidate : undefined;
  };
  const constant = value("const");
  return {
    type: string("type"),
    const:
      constant === null ||
      typeof constant === "string" ||
      typeof constant === "number" ||
      typeof constant === "boolean"
        ? constant
        : undefined,
    minimum: number("minimum"),
    maximum: number("maximum"),
    minLength: number("minLength"),
    maxLength: number("maxLength"),
    pattern: string("pattern"),
    format: string("format"),
  };
}

function scalarEntries(): readonly (readonly [string, AST.AST])[] {
  const entries = new Map<string, AST.AST>();
  const visit = (source: AST.AST): void => {
    const value = unrefined(source);
    const identifier = Option.getOrUndefined(AST.getIdentifierAnnotation(source));
    if (
      identifier !== undefined &&
      !AST.isTypeLiteral(value) &&
      !(AST.isUnion(value) && !value.types.every(AST.isLiteral))
    )
      entries.set(identifier, source);
    if (AST.isTypeLiteral(value)) {
      for (const field of value.propertySignatures) visit(field.type);
    } else if (AST.isTupleType(value)) {
      for (const element of value.elements) visit(element.type);
      for (const element of value.rest) visit(element.type);
    } else if (AST.isUnion(value)) {
      for (const member of value.types) visit(member);
    }
  };
  for (const schema of Object.values(protocolSchemaDefinitions)) visit(schema.ast);
  return [...entries];
}

function swiftStringValidation(schema: WireSchema, value = "value"): string {
  const conditions: string[] = [];
  if (schema.minLength !== undefined) conditions.push(`${value}.count >= ${schema.minLength}`);
  if (schema.maxLength !== undefined) conditions.push(`${value}.count <= ${schema.maxLength}`);
  if (schema.pattern !== undefined)
    conditions.push(
      `EnchiridionValidation.matches(${value}, pattern: ${JSON.stringify(schema.pattern)})`,
    );
  if (schema.format === "p256-spki-der")
    conditions.push(`EnchiridionValidation.p256SPKI(${value})`);
  if (schema.format === "p256-ecdsa-der")
    conditions.push(`EnchiridionValidation.p256Signature(${value})`);
  if (schema.format === "base64-canonical")
    conditions.push(`EnchiridionValidation.canonicalBase64(${value}) != nil`);
  if (schema.format === "base64url-128")
    conditions.push(`EnchiridionValidation.canonicalFrameID(${value})`);
  return conditions.length === 0 ? "true" : conditions.join(" && ");
}

function swiftScalar(identifier: string, source: AST.AST): string {
  if (identifier === "ErrorCode") return "";
  const schema = wireSchema(source);
  const name = `Enchiridion${identifier}`;
  if (schema.type === "string" || typeof schema.const === "string") {
    const constant =
      typeof schema.const === "string" ? `value == ${JSON.stringify(schema.const)}` : "true";
    return `public struct ${name}: Codable, Equatable, Hashable, Sendable {\n  public let value: String\n  public init(_ value: String) throws { guard ${constant} && ${swiftStringValidation(schema)} else { throw EnchiridionProtocolValidationError.invalidValue("${identifier}") }; self.value = value }\n  public init(from decoder: Decoder) throws { try self.init(try decoder.singleValueContainer().decode(String.self)) }\n  public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(value) }\n}`;
  }
  if (schema.type === "number" || schema.type === "integer" || typeof schema.const === "number") {
    const constant = typeof schema.const === "number" ? `value == ${schema.const}` : "true";
    const defaultValue = typeof schema.const === "number" ? ` = ${schema.const}` : "";
    const bounds = [
      schema.minimum === undefined ? "" : `value >= ${schema.minimum}`,
      schema.maximum === undefined ? "" : `value <= ${schema.maximum}`,
    ]
      .filter(Boolean)
      .join(" && ");
    return `public struct ${name}: Codable, Equatable, Hashable, Sendable {\n  public let value: Int\n  public init(_ value: Int${defaultValue}) throws { guard ${constant}${bounds === "" ? "" : ` && ${bounds}`} else { throw EnchiridionProtocolValidationError.invalidValue("${identifier}") }; self.value = value }\n  public init(from decoder: Decoder) throws { try self.init(try decoder.singleValueContainer().decode(Int.self)) }\n  public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(value) }\n}`;
  }
  throw new TypeError(`Unsupported named scalar ${identifier}.`);
}

/** Projects one canonical model entry; the drift test exercises this directly. */
export function generatedSwiftModel(name: string, schema: { readonly ast: AST.AST }): string {
  const schemaAST = unrefined(schema.ast);
  if (!AST.isTypeLiteral(schemaAST))
    throw new TypeError(`${name} must be an Effect Schema Struct.`);
  const fields = schemaAST.propertySignatures;
  const usable = fields.filter(
    (field): field is typeof field & { readonly name: string } => typeof field.name === "string",
  );
  const properties = usable
    .map(
      (field) =>
        `  public let ${field.name}: ${swiftType(field.type)}${field.isOptional ? "?" : ""}`,
    )
    .join("\n");
  const initializerArguments = usable
    .map((field) => `${field.name}: ${swiftType(field.type)}${field.isOptional ? "? = nil" : ""}`)
    .join(", ");
  const assignments = usable.map((field) => `    self.${field.name} = ${field.name}`).join("\n");
  const codingKeys = usable.map((field) => field.name).join(", ");
  const decode = usable
    .map((field) => {
      const decoded = `try c.${field.isOptional ? "decodeIfPresent" : "decode"}(${swiftType(field.type)}.self, forKey: .${field.name})`;
      const literal = literalValue(field.type);
      const validation =
        literal === undefined
          ? ""
          : `\n    guard ${field.name} == ${JSON.stringify(literal)} else { throw EnchiridionProtocolValidationError.invalidValue("${field.name}") }`;
      return `    let ${field.name} = ${decoded}${validation}`;
    })
    .join("\n");
  const encodeValidation = usable
    .flatMap((field) => {
      const literal = literalValue(field.type);
      return literal === undefined
        ? []
        : [
            `    guard ${field.name} == ${JSON.stringify(literal)} else { throw EnchiridionProtocolValidationError.invalidValue("${field.name}") }`,
          ];
    })
    .join("\n");
  const encode = usable
    .map(
      (field) =>
        `    try c.${field.isOptional ? "encodeIfPresent" : "encode"}(${field.name}, forKey: .${field.name})`,
    )
    .join("\n");
  return `public struct ${name}: Codable, Equatable, Sendable {\n${properties}\n  private enum CodingKeys: String, CodingKey { case ${codingKeys} }\n  public init(${initializerArguments}) {\n${assignments}\n  }\n  public init(from decoder: Decoder) throws {\n    let all = try decoder.container(keyedBy: EnchiridionAnyCodingKey.self)\n    guard all.allKeys.allSatisfy({ CodingKeys(stringValue: $0.stringValue) != nil }) else { throw EnchiridionProtocolValidationError.invalidValue("${name} unknown key") }\n    let c = try decoder.container(keyedBy: CodingKeys.self)\n${decode}\n${assignments}\n  }\n  public func encode(to encoder: Encoder) throws {\n${encodeValidation}\n    var c = encoder.container(keyedBy: CodingKeys.self)\n${encode}\n  }\n}`;
}

const generatedScalarTypes = scalarEntries()
  .map(([name, ast]) => swiftScalar(name, ast))
  .filter(Boolean)
  .join("\n\n");

const generatedModels = Object.entries(protocolSchemaDefinitions)
  .filter(([name]) => !["ClientWebSocketFrame", "ServerWebSocketFrame"].includes(name))
  .map(([name, schema]) => generatedSwiftModel(name, schema))
  .join("\n\n");

const swiftErrorCases = errorCodes
  .map((code) => {
    const name = code.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return `  case ${name} = "${code}"`;
  })
  .join("\n");

/** Generated source is deliberately Foundation-only and imports no app module. */
export function generatedSwiftAPI(): string {
  return String.raw`// Generated by @enchiridion/protocol. DO NOT EDIT.
// Regenerate with: bun run --cwd packages/protocol generate
import Foundation

public enum EnchiridionProtocol {
  public static let version = ${protocolVersion}
  public static let websocketNegotiationFailureCloseCode = ${websocketContract.negotiationFailureCloseCode}
  public static let maximumPayloadBase64Length = 1398104
}

public enum EnchiridionProtocolValidationError: Error, Equatable, Sendable {
  case invalidValue(String)
}

private struct EnchiridionAnyCodingKey: CodingKey {
  let stringValue: String
  let intValue: Int?
  init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
  init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
}

private enum EnchiridionValidation {
  static func matches(_ value: String, pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }
  static func canonicalBase64(_ value: String) -> [UInt8]? {
    guard let data = Data(base64Encoded: value), data.base64EncodedString() == value else { return nil }
    return Array(data)
  }
  static func canonicalFrameID(_ value: String) -> Bool {
    guard value.count == 22 else { return false }
    let standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=="
    guard let data = canonicalBase64(standard), data.count == 16 else { return false }
    return Data(data).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "==", with: "") == value
  }
  static func derLength(_ bytes: [UInt8], at offset: Int) -> (Int, Int)? {
    guard offset < bytes.count else { return nil }
    let first = Int(bytes[offset])
    if first < 0x80 { return (first, offset + 1) }
    let count = first & 0x7f
    guard count > 0, count <= 2, offset + count < bytes.count, bytes[offset + 1] != 0 else { return nil }
    var length = 0
    for index in 1...count { length = (length << 8) | Int(bytes[offset + index]) }
    return length >= 0x80 ? (length, offset + count + 1) : nil
  }
  static func positiveIntegerEnd(_ bytes: [UInt8], at offset: Int) -> Int? {
    guard offset < bytes.count, bytes[offset] == 0x02, let (size, content) = derLength(bytes, at: offset + 1), size >= 1, size <= 33, content + size <= bytes.count else { return nil }
    let first = bytes[content]
    guard (first & 0x80) == 0 else { return nil }
    if size > 1, first == 0, (bytes[content + 1] & 0x80) == 0 { return nil }
    return content + size
  }
  static func p256Signature(_ value: String) -> Bool {
    guard let bytes = canonicalBase64(value), bytes.count >= 8 else { return false }
    guard bytes[0] == 0x30, let (size, content) = derLength(bytes, at: 1), content + size == bytes.count, let rEnd = positiveIntegerEnd(bytes, at: content), let sEnd = positiveIntegerEnd(bytes, at: rEnd) else { return false }
    return sEnd == bytes.count
  }
  static func p256SPKI(_ value: String) -> Bool {
    let prefix: [UInt8] = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04]
    guard let bytes = canonicalBase64(value), bytes.count == 91 else { return false }
    return zip(prefix, bytes).allSatisfy(==)
  }
}

${generatedScalarTypes}

public enum EnchiridionErrorCode: String, Codable, Equatable, Sendable {
${swiftErrorCases}
}

${generatedModels}

public enum EnchiridionAPIError: Error, Equatable, Sendable {
  case invalidBaseURL
  case invalidResponse
  case httpStatus(Int, ErrorEnvelope?)
  case encoding
  case decoding
  case transport(String)
}
public protocol EnchiridionHTTPTransport: Sendable { func execute(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) }
extension URLSession: EnchiridionHTTPTransport {
  public func execute(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await data(for: request)
    guard let http = response as? HTTPURLResponse else { throw EnchiridionAPIError.invalidResponse }
    return (data, http)
  }
}
public struct EnchiridionHTTPClient: Sendable {
  public let baseURL: URL
  private let transport: any EnchiridionHTTPTransport
  public init(baseURL: URL, transport: any EnchiridionHTTPTransport = URLSession.shared) throws {
    guard baseURL.scheme?.lowercased() == "https", baseURL.host != nil else { throw EnchiridionAPIError.invalidBaseURL }
    self.baseURL = baseURL
    self.transport = transport
  }
  public func registerDevice(_ body: DeviceRegisterRequest, accessToken: String) async throws -> DeviceRegisterResponse { try await send(path: "/v2/devices/register", body: body, accessToken: accessToken) }
  public func revokeDevice(deviceID: EnchiridionDeviceID, body: DeviceRevokeRequest, accessToken: String) async throws -> DeviceRevokeResponse { try await send(path: "/v2/devices/\(Self.percentEncodedPathSegment(deviceID.value))/revoke", body: body, accessToken: accessToken) }
  /// RFC 3986 unreserved-only URL path segment encoding, applied exactly once.
  public static func percentEncodedPathSegment(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"))! }
  private func send<Request: Encodable & Sendable, Response: Decodable & Sendable>(path: String, body: Request, accessToken: String) async throws -> Response {
    guard !accessToken.isEmpty, let url = URL(string: path, relativeTo: baseURL) else { throw EnchiridionAPIError.invalidResponse }
    var request = URLRequest(url: url); request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    do { request.httpBody = try JSONEncoder().encode(body) } catch { throw EnchiridionAPIError.encoding }
    let data: Data; let response: HTTPURLResponse
    do { (data, response) = try await transport.execute(request) } catch let error as EnchiridionAPIError { throw error } catch { throw EnchiridionAPIError.transport(String(describing: error)) }
    guard (200...299).contains(response.statusCode) else { throw EnchiridionAPIError.httpStatus(response.statusCode, try? JSONDecoder().decode(ErrorEnvelope.self, from: data)) }
    do { return try JSONDecoder().decode(Response.self, from: data) } catch { throw EnchiridionAPIError.decoding }
  }
}

public enum EnchiridionSyncChangeSigningPayload {
  public static let version = ${syncFrameSigningPayloadVersion}
  public static func canonicalBytes(_ frame: SyncChangeFrame) -> Data {
    let fields = [String(frame.protocolVersion.value), frame.vaultID.value, frame.deviceID.value, String(frame.authEpoch.value), frame.changeID.value, String(frame.causalVersion.value), frame.frameID.value, frame.payloadBase64.value]
    var bytes = Data("ENCHSYNC".utf8); bytes.append(UInt8(version))
    for field in fields { let fieldBytes = Data(field.utf8); var length = UInt32(fieldBytes.count).bigEndian; withUnsafeBytes(of: &length) { bytes.append(contentsOf: $0) }; bytes.append(fieldBytes) }
    return bytes
  }
}

public enum EnchiridionClientWebSocketFrame: Codable, Equatable, Sendable {
  case hello(HelloFrame)
  case syncChange(SyncChangeFrame)
  private enum Kind: String, Codable { case hello, syncChange }
  public init(from decoder: Decoder) throws { let kind = try decoder.container(keyedBy: CodingKeys.self).decode(Kind.self, forKey: .type); switch kind { case .hello: self = .hello(try HelloFrame(from: decoder)); case .syncChange: self = .syncChange(try SyncChangeFrame(from: decoder)) } }
  public func encode(to encoder: Encoder) throws { switch self { case let .hello(frame): guard frame.type == "hello" else { throw EnchiridionProtocolValidationError.invalidValue("hello type") }; try frame.encode(to: encoder); case let .syncChange(frame): guard frame.type == "syncChange" else { throw EnchiridionProtocolValidationError.invalidValue("syncChange type") }; try frame.encode(to: encoder) } }
  private enum CodingKeys: String, CodingKey { case type }
}
public enum EnchiridionServerWebSocketFrame: Codable, Equatable, Sendable {
  case helloAccepted(HelloAcceptedFrame)
  case syncAcknowledged(SyncAcknowledgedFrame)
  case error(ProtocolErrorFrame)
  private enum Kind: String, Codable { case helloAccepted, syncAcknowledged, error }
  public init(from decoder: Decoder) throws { let kind = try decoder.container(keyedBy: CodingKeys.self).decode(Kind.self, forKey: .type); switch kind { case .helloAccepted: self = .helloAccepted(try HelloAcceptedFrame(from: decoder)); case .syncAcknowledged: self = .syncAcknowledged(try SyncAcknowledgedFrame(from: decoder)); case .error: self = .error(try ProtocolErrorFrame(from: decoder)) } }
  public func encode(to encoder: Encoder) throws { switch self { case let .helloAccepted(frame): guard frame.type == "helloAccepted" else { throw EnchiridionProtocolValidationError.invalidValue("helloAccepted type") }; try frame.encode(to: encoder); case let .syncAcknowledged(frame): guard frame.type == "syncAcknowledged" else { throw EnchiridionProtocolValidationError.invalidValue("syncAcknowledged type") }; try frame.encode(to: encoder); case let .error(frame): guard frame.type == "error" else { throw EnchiridionProtocolValidationError.invalidValue("error type") }; try frame.encode(to: encoder) } }
  private enum CodingKeys: String, CodingKey { case type }
}
public protocol EnchiridionWebSocketTransport: Sendable {
  func send(_ frame: EnchiridionClientWebSocketFrame) async throws
  func receive() async throws -> EnchiridionServerWebSocketFrame
  func close(code: URLSessionWebSocketTask.CloseCode, reason: Data?)
}
`;
}
