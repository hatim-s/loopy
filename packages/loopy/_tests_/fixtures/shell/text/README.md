# Text parser fixtures

Captured on Darwin on 2026-10-17 with the system wc, uniq, grep and shasum,
and jq 1.7.1. Commands ran with LC_ALL=C in a disposable directory.
words.txt contained `hello world\nhello world\nbye\n`; space name.txt contained
`second\n`. data.json contained `[{"n":1},{"n":2}]`.

Capture commands:

- `wc words.txt 'space name.txt'`
- `uniq -c words.txt`
- `grep -n hello words.txt`
- `grep -n -H e words.txt 'space name.txt'`
- `grep -c hello words.txt`
- `shasum -a 256 words.txt 'space name.txt'`
- `jq -c '.[]' data.json`

Checksum tests reuse the Darwin capture for ordinary paths and check GNU filename
escaping separately.
GNU documents hash, space, text/binary mode marker, filename and escaped filename
handling in [checksum output modes](https://www.gnu.org/software/coreutils/manual/html_node/cksum-output-modes.html).
The Linux wrapper runs sha256sum; Darwin runs shasum -a 256.

Grep uses line numbers, adding -H for multiple paths. Context and output mode
flags stay raw because they change record shapes. Numeric filenames and filenames
containing colon-delimited numbers can be ambiguous in grep's line format.
Grep returns text records in matches and binary filenames in binaryMatches.
GrepCount accepts one file or stdin, suppresses filenames and rejects recursion,
explicit patterns and pattern files. Use .raw() for those flags.
Wc drops only the final aggregate row when given multiple file operands. Both wc and grep retain the limitations of their
line-based tool formats for filenames containing newlines.

Uniq stays raw; uniqCount presets -c. Diff, sort, head, tail, cut, tr, sed, awk,
base64 and yq stay raw. Their output depends on the requested transformation,
and yq has no guaranteed installation. Jq.raw retains raw string output.
