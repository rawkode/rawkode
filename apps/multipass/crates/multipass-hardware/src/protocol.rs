#[derive(Clone, Copy)]
pub(crate) struct Request {
    feature: u8,
    function: u8,
}
#[derive(Debug, PartialEq)]
pub(crate) enum Reply {
    Data(Vec<u8>),
    Error(u8),
}
impl Request {
    pub(crate) fn new(feature: u8, function: u8) -> Self {
        Self { feature, function }
    }
    pub(crate) fn encode(self, parameters: &[u8]) -> [u8; 20] {
        let mut bytes = [0; 20];
        bytes[..4].copy_from_slice(&[0x11, 0xff, self.feature, (self.function << 4) | 0x0d]);
        let n = parameters.len().min(16);
        bytes[4..4 + n].copy_from_slice(&parameters[..n]);
        bytes
    }
    pub(crate) fn decode(self, bytes: &[u8]) -> Option<Reply> {
        let expected_len = match bytes.first()? {
            0x10 => 7,
            0x11 => 20,
            _ => return None,
        };
        if bytes.len() != expected_len || bytes[1] != 0xff {
            return None;
        }
        let function_id = (self.function << 4) | 0x0d;
        // HID++ 2.0 errors embed the original feature and complete function/software ID.
        if bytes[2] == 0xff && bytes[3] == self.feature && bytes[4] == function_id {
            return Some(Reply::Error(bytes[5]));
        }
        if bytes[2] != self.feature || bytes[3] != function_id {
            return None;
        }
        Some(Reply::Data(bytes[4..].to_vec()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_encoding() {
        assert_eq!(
            &Request::new(9, 1).encode(&[1])[..6],
            &[0x11, 0xff, 9, 0x1d, 1, 0]
        );
    }
    #[test]
    fn accepts_short_and_long() {
        assert!(matches!(
            Request::new(9, 0).decode(&[0x10, 0xff, 9, 0x0d, 3, 0, 0]),
            Some(Reply::Data(_))
        ));
        assert!(matches!(
            Request::new(9, 0).decode(&Request::new(9, 0).encode(&[3, 0])),
            Some(Reply::Data(_))
        ));
    }
    #[test]
    fn rejects_unrelated_reports_and_truncation() {
        let request = Request::new(9, 1);
        let valid = request.encode(&[1]);
        for offset in 0..4 {
            let mut invalid = valid;
            invalid[offset] ^= 1;
            assert_eq!(request.decode(&invalid), None);
        }
        assert_eq!(request.decode(&valid[..19]), None);
        let mut notification = valid;
        notification[3] = 0x10;
        assert_eq!(request.decode(&notification), None);
    }
    #[test]
    fn error_reply_matches_original_request() {
        let request = Request::new(9, 1);
        assert_eq!(
            request.decode(&[0x10, 0xff, 0xff, 9, 0x1d, 7, 0]),
            Some(Reply::Error(7))
        );
        assert_eq!(request.decode(&[0x10, 0xff, 0xff, 9, 0x1c, 7, 0]), None);
        assert_eq!(request.decode(&[0x10, 0xfe, 0xff, 9, 0x1d, 7, 0]), None);
    }
}
