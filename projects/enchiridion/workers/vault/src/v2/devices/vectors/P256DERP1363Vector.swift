import Foundation

// Consumed by the native P03-03 verification check without importing Worker source.
enum EnchiridionP256DERP1363Vector {
  static let messageUTF8 = "enchiridion-p256-vector-v1"
  static let spkiDERBase64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeRo6IA5qHb0Clfwa7yCD4u0UOVCKLCcaGkWz1/94iIrBm/IjXooNCCb3LCnkD8iM899EHZ3CswgZ3zSXHHERUA=="
  static let signatureDERBase64 = "MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew=="
  static let signatureP1363Base64 = "CG5y3idBVD4QzwT9I7bvr5KGycsfojCW5hCZsWK3L04dJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew=="
  static let highSSignatureDERBase64Rejected = "MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY="
}
