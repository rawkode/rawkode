/// The exact ECMAScript WhiteSpace and LineTerminator scalar set used by
/// `String.prototype.trim()`. Keep this explicit: Foundation's whitespace set differs, notably
/// by excluding U+FEFF BYTE ORDER MARK, which is ECMAScript whitespace.
public func trimECMAScriptWhitespace(_ value: String) -> String {
    let scalars = value.unicodeScalars
    var start = scalars.startIndex
    var end = scalars.endIndex

    while start != end, isECMAScriptTrimScalar(scalars[start]) {
        start = scalars.index(after: start)
    }
    while start != end {
        let previous = scalars.index(before: end)
        guard isECMAScriptTrimScalar(scalars[previous]) else { break }
        end = previous
    }
    return String(scalars[start..<end])
}

/// Returns whether the original scalar sequence is already ECMAScript-trimmed. Swift `String`
/// equality is Unicode-canonical-equivalence based, so use scalar equality here: request IDs are
/// wire identities and U+FEFF must not compare equal to its trimmed-away form.
public func isECMAScriptTrimmed(_ value: String) -> Bool {
    value.unicodeScalars.elementsEqual(trimECMAScriptWhitespace(value).unicodeScalars)
}

private func isECMAScriptTrimScalar(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0,
         0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    default:
        return false
    }
}
