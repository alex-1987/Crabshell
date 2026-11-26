//! SFTP version 3 (draft-ietf-secsh-filexfer-02), the file protocol OpenSSH's `sftp-server`
//! speaks. Only encoding and decoding here, no I/O; the transport is OpenSSH (`ssh -s … sftp`).

use serde::Serialize;

pub(crate) const VERSION: u32 = 3;

// Packet types.
pub(crate) const INIT: u8 = 1;
const VERSION_REPLY: u8 = 2;
const OPEN: u8 = 3;
const CLOSE: u8 = 4;
const READ: u8 = 5;
const WRITE: u8 = 6;
const LSTAT: u8 = 7;
const OPENDIR: u8 = 11;
const READDIR: u8 = 12;
const REMOVE: u8 = 13;
const MKDIR: u8 = 14;
const RMDIR: u8 = 15;
const REALPATH: u8 = 16;
const STAT: u8 = 17;
const RENAME: u8 = 18;
const STATUS: u8 = 101;
const HANDLE: u8 = 102;
const DATA: u8 = 103;
const NAME: u8 = 104;
const ATTRS: u8 = 105;

// Open flags.
pub(crate) const OPEN_READ: u32 = 0x01;
pub(crate) const OPEN_WRITE: u32 = 0x02;
pub(crate) const OPEN_CREATE: u32 = 0x08;
pub(crate) const OPEN_TRUNCATE: u32 = 0x10;

// Attribute flags.
const ATTR_SIZE: u32 = 0x01;
const ATTR_UIDGID: u32 = 0x02;
const ATTR_PERMISSIONS: u32 = 0x04;
const ATTR_ACMODTIME: u32 = 0x08;
const ATTR_EXTENDED: u32 = 0x8000_0000;

// Status codes.
pub(crate) const STATUS_OK: u32 = 0;
pub(crate) const STATUS_EOF: u32 = 1;
const STATUS_NO_SUCH_FILE: u32 = 2;
const STATUS_PERMISSION_DENIED: u32 = 3;

/// OpenSSH accepts packets up to 256 KiB; anything larger is a broken stream.
pub(crate) const MAX_PACKET: usize = 256 * 1024 + 1024;

/// File attributes as far as the server sends them.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Attrs {
    pub size: Option<u64>,
    pub permissions: Option<u32>,
    pub modified: Option<u32>,
}

impl Attrs {
    fn file_type(&self) -> u32 {
        self.permissions.unwrap_or(0) & 0o170_000
    }
    pub fn is_dir(&self) -> bool {
        self.file_type() == 0o040_000
    }
    pub fn is_link(&self) -> bool {
        self.file_type() == 0o120_000
    }
}

/// One directory entry for the file browser.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// Seconds since 1970; 0 when unknown.
    pub modified: u32,
    /// Unix mode bits (e.g. 0o755) without the file type.
    pub permissions: u32,
}

impl FileEntry {
    pub fn new(name: String, attrs: &Attrs) -> Self {
        Self {
            name,
            is_dir: attrs.is_dir(),
            is_link: attrs.is_link(),
            size: attrs.size.unwrap_or(0),
            modified: attrs.modified.unwrap_or(0),
            permissions: attrs.permissions.unwrap_or(0) & 0o7777,
        }
    }
}

/// A reply from the server.
#[derive(Debug, PartialEq)]
pub(crate) enum Response {
    Status { code: u32, message: String },
    Handle(Vec<u8>),
    Data(Vec<u8>),
    Name(Vec<(String, Attrs)>),
    Attrs(Attrs),
}

impl Response {
    /// OK status, or the error as text.
    pub fn ok(self) -> Result<(), String> {
        match self {
            Self::Status {
                code: STATUS_OK, ..
            } => Ok(()),
            other => Err(other.error()),
        }
    }

    pub fn handle(self) -> Result<Vec<u8>, String> {
        match self {
            Self::Handle(handle) => Ok(handle),
            other => Err(other.error()),
        }
    }

    pub fn attrs(self) -> Result<Attrs, String> {
        match self {
            Self::Attrs(attrs) => Ok(attrs),
            other => Err(other.error()),
        }
    }

    /// The error a reply stands for when it was not the expected one.
    pub fn error(&self) -> String {
        match self {
            Self::Status { code, message } => status_error(*code, message),
            _ => "The server sent an unexpected answer".to_string(),
        }
    }
}

/// Status codes as messages the frontend translates.
pub(crate) fn status_error(code: u32, message: &str) -> String {
    match code {
        STATUS_NO_SUCH_FILE => "The file or folder does not exist".to_string(),
        STATUS_PERMISSION_DENIED => "Permission denied on the server".to_string(),
        STATUS_EOF => "Unexpected end of file".to_string(),
        _ if message.trim().is_empty() => "The server reported an error".to_string(),
        // Already human readable (e.g. "Directory not empty", "File exists").
        _ => message.trim().chars().take(200).collect(),
    }
}

// ------------------------------------------------------------------ encoding

/// Builds one packet: length, type, request id and the fields.
pub(crate) struct Packet(Vec<u8>);

impl Packet {
    fn new(kind: u8, id: u32) -> Self {
        let mut bytes = vec![0, 0, 0, 0, kind];
        bytes.extend_from_slice(&id.to_be_bytes());
        Self(bytes)
    }

    fn u32(mut self, value: u32) -> Self {
        self.0.extend_from_slice(&value.to_be_bytes());
        self
    }

    fn u64(mut self, value: u64) -> Self {
        self.0.extend_from_slice(&value.to_be_bytes());
        self
    }

    fn bytes(mut self, value: &[u8]) -> Self {
        // Fields are far below 4 GiB (paths, handles, 32 KiB chunks).
        self = self.u32(value.len() as u32);
        self.0.extend_from_slice(value);
        self
    }

    fn str(self, value: &str) -> Self {
        self.bytes(value.as_bytes())
    }

    /// Final bytes with the length filled in.
    pub fn finish(mut self) -> Vec<u8> {
        let len = (self.0.len() - 4) as u32;
        self.0[..4].copy_from_slice(&len.to_be_bytes());
        self.0
    }
}

pub(crate) fn init() -> Vec<u8> {
    let mut bytes = vec![0, 0, 0, 5, INIT];
    bytes.extend_from_slice(&VERSION.to_be_bytes());
    bytes
}

pub(crate) fn open(id: u32, path: &str, flags: u32) -> Vec<u8> {
    // No attributes: the server applies its umask.
    Packet::new(OPEN, id).str(path).u32(flags).u32(0).finish()
}

pub(crate) fn close(id: u32, handle: &[u8]) -> Vec<u8> {
    Packet::new(CLOSE, id).bytes(handle).finish()
}

pub(crate) fn read(id: u32, handle: &[u8], offset: u64, len: u32) -> Vec<u8> {
    Packet::new(READ, id)
        .bytes(handle)
        .u64(offset)
        .u32(len)
        .finish()
}

pub(crate) fn write(id: u32, handle: &[u8], offset: u64, data: &[u8]) -> Vec<u8> {
    Packet::new(WRITE, id)
        .bytes(handle)
        .u64(offset)
        .bytes(data)
        .finish()
}

pub(crate) fn opendir(id: u32, path: &str) -> Vec<u8> {
    Packet::new(OPENDIR, id).str(path).finish()
}

pub(crate) fn readdir(id: u32, handle: &[u8]) -> Vec<u8> {
    Packet::new(READDIR, id).bytes(handle).finish()
}

pub(crate) fn stat(id: u32, path: &str) -> Vec<u8> {
    Packet::new(STAT, id).str(path).finish()
}

pub(crate) fn lstat(id: u32, path: &str) -> Vec<u8> {
    Packet::new(LSTAT, id).str(path).finish()
}

pub(crate) fn remove(id: u32, path: &str) -> Vec<u8> {
    Packet::new(REMOVE, id).str(path).finish()
}

pub(crate) fn mkdir(id: u32, path: &str) -> Vec<u8> {
    Packet::new(MKDIR, id).str(path).u32(0).finish()
}

pub(crate) fn rmdir(id: u32, path: &str) -> Vec<u8> {
    Packet::new(RMDIR, id).str(path).finish()
}

pub(crate) fn realpath(id: u32, path: &str) -> Vec<u8> {
    Packet::new(REALPATH, id).str(path).finish()
}

pub(crate) fn rename(id: u32, from: &str, to: &str) -> Vec<u8> {
    Packet::new(RENAME, id).str(from).str(to).finish()
}

// ------------------------------------------------------------------ decoding

/// Reads fields from a packet body; every read checks the remaining length.
struct Reader<'a> {
    data: &'a [u8],
}

const TRUNCATED: &str = "The server sent a broken answer";

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        if self.data.len() < len {
            return Err(TRUNCATED.to_string());
        }
        let (head, rest) = self.data.split_at(len);
        self.data = rest;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok((u64::from(self.u32()?) << 32) | u64::from(self.u32()?))
    }

    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    fn string(&mut self) -> Result<String, String> {
        Ok(String::from_utf8_lossy(self.bytes()?).into_owned())
    }

    fn attrs(&mut self) -> Result<Attrs, String> {
        let flags = self.u32()?;
        let mut attrs = Attrs::default();
        if flags & ATTR_SIZE != 0 {
            attrs.size = Some(self.u64()?);
        }
        if flags & ATTR_UIDGID != 0 {
            self.take(8)?;
        }
        if flags & ATTR_PERMISSIONS != 0 {
            attrs.permissions = Some(self.u32()?);
        }
        if flags & ATTR_ACMODTIME != 0 {
            self.u32()?;
            attrs.modified = Some(self.u32()?);
        }
        if flags & ATTR_EXTENDED != 0 {
            for _ in 0..self.u32()? {
                self.bytes()?;
                self.bytes()?;
            }
        }
        Ok(attrs)
    }
}

/// The protocol version from the server's VERSION packet body (type byte included).
pub(crate) fn parse_version(body: &[u8]) -> Result<u32, String> {
    let mut reader = Reader { data: body };
    if reader.u8()? != VERSION_REPLY {
        return Err("The server does not speak SFTP".to_string());
    }
    reader.u32()
}

/// Request id and reply from a packet body (type byte included, length prefix removed).
pub(crate) fn parse_response(body: &[u8]) -> Result<(u32, Response), String> {
    let mut reader = Reader { data: body };
    let kind = reader.u8()?;
    let id = reader.u32()?;
    let response = match kind {
        STATUS => {
            let code = reader.u32()?;
            // Version 3 servers may leave out the message.
            let message = if reader.data.is_empty() {
                String::new()
            } else {
                reader.string()?
            };
            Response::Status { code, message }
        }
        HANDLE => Response::Handle(reader.bytes()?.to_vec()),
        DATA => Response::Data(reader.bytes()?.to_vec()),
        NAME => {
            let count = reader.u32()?;
            let mut names = Vec::with_capacity(count.min(1024) as usize);
            for _ in 0..count {
                let name = reader.string()?;
                reader.bytes()?; // long name ("ls -l" line), not needed
                names.push((name, reader.attrs()?));
            }
            Response::Name(names)
        }
        ATTRS => Response::Attrs(reader.attrs()?),
        _ => return Err("The server sent an unexpected answer".to_string()),
    };
    Ok((id, response))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(packet: &[u8]) -> &[u8] {
        let len = u32::from_be_bytes([packet[0], packet[1], packet[2], packet[3]]) as usize;
        assert_eq!(len, packet.len() - 4, "length prefix");
        &packet[4..]
    }

    #[test]
    fn encodes_requests() {
        assert_eq!(init(), [0, 0, 0, 5, 1, 0, 0, 0, 3]);
        assert_eq!(
            body(&opendir(7, "/tmp")),
            [11, 0, 0, 0, 7, 0, 0, 0, 4, b'/', b't', b'm', b'p']
        );
        let write = write(1, b"h", 0x1_0000_0002, b"xy");
        assert_eq!(
            body(&write),
            [6, 0, 0, 0, 1, 0, 0, 0, 1, b'h', 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 2, b'x', b'y']
        );
        assert_eq!(
            body(&rename(2, "a", "b")),
            [18, 0, 0, 0, 2, 0, 0, 0, 1, b'a', 0, 0, 0, 1, b'b']
        );
        let open = open(3, "f", OPEN_WRITE | OPEN_CREATE | OPEN_TRUNCATE);
        assert_eq!(&body(&open)[10..], [0, 0, 0, 0x1a, 0, 0, 0, 0]);
    }

    /// Builds a reply the way a server would.
    fn reply(kind: u8, id: u32, fields: &[u8]) -> Vec<u8> {
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&id.to_be_bytes());
        bytes.extend_from_slice(fields);
        bytes
    }

    fn string(value: &[u8]) -> Vec<u8> {
        let mut bytes = (value.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(value);
        bytes
    }

    #[test]
    fn decodes_status_handle_and_data() {
        let mut fields = 2u32.to_be_bytes().to_vec();
        fields.extend(string(b"No such file"));
        fields.extend(string(b"en"));
        let (id, response) = parse_response(&reply(101, 9, &fields)).unwrap();
        assert_eq!(id, 9);
        assert_eq!(response.error(), "The file or folder does not exist");

        // Status without message (allowed in version 3).
        let (_, ok) = parse_response(&reply(101, 1, &0u32.to_be_bytes())).unwrap();
        assert!(ok.ok().is_ok());

        let (_, handle) = parse_response(&reply(102, 2, &string(b"H1"))).unwrap();
        assert_eq!(handle.handle().unwrap(), b"H1");
        let (_, data) = parse_response(&reply(103, 3, &string(b"abc"))).unwrap();
        assert_eq!(data, Response::Data(b"abc".to_vec()));

        assert_eq!(
            status_error(4, "Directory not empty"),
            "Directory not empty"
        );
    }

    #[test]
    fn decodes_names_with_attributes() {
        let mut fields = 2u32.to_be_bytes().to_vec();
        // A directory with size, uid/gid, permissions and times.
        fields.extend(string(b"logs"));
        fields.extend(string(b"drwxr-xr-x ..."));
        fields.extend((ATTR_SIZE | ATTR_UIDGID | ATTR_PERMISSIONS | ATTR_ACMODTIME).to_be_bytes());
        fields.extend(4096u64.to_be_bytes());
        fields.extend([0u8; 8]);
        fields.extend(0o040_755u32.to_be_bytes());
        fields.extend(1u32.to_be_bytes());
        fields.extend(1_700_000_000u32.to_be_bytes());
        // A symlink with an extended attribute and nothing else.
        fields.extend(string(b"current"));
        fields.extend(string(b""));
        fields.extend((ATTR_PERMISSIONS | ATTR_EXTENDED).to_be_bytes());
        fields.extend(0o120_777u32.to_be_bytes());
        fields.extend(1u32.to_be_bytes());
        fields.extend(string(b"key"));
        fields.extend(string(b"value"));

        let (_, response) = parse_response(&reply(104, 4, &fields)).unwrap();
        let Response::Name(names) = response else {
            panic!("expected names");
        };
        let logs = FileEntry::new(names[0].0.clone(), &names[0].1);
        assert!(logs.is_dir && !logs.is_link);
        assert_eq!(
            (logs.size, logs.modified, logs.permissions),
            (4096, 1_700_000_000, 0o755)
        );
        let link = FileEntry::new(names[1].0.clone(), &names[1].1);
        assert!(link.is_link && !link.is_dir);
    }

    #[test]
    fn rejects_truncated_and_unknown_packets() {
        assert!(parse_response(&[101, 0, 0]).is_err());
        assert!(parse_response(&reply(102, 1, &[0, 0, 0, 9, b'x'])).is_err());
        assert!(parse_response(&reply(200, 1, &[])).is_err());
        assert_eq!(parse_version(&[2, 0, 0, 0, 3]).unwrap(), 3);
        assert!(parse_version(&[101, 0, 0, 0, 3]).is_err());
    }
}
