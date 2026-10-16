# Filesystem parser fixtures

Captured on Darwin on 2026-10-17 from a disposable directory with the system
find, stat, du, df, realpath, which and mktemp. Tree 2.3.2 was installed with
Homebrew for this capture. Commands ran with LC_ALL=C.

The directory contained words.txt with `hello world\nhello world\nbye\n`,
space name.txt with `second\n`, an empty nested directory and link -> words.txt.
Regular files and nested have mtime 1700000000. The link retains capture time.
Temporary absolute paths, disk usage and the mktemp suffix are actual output.

Capture commands:

- `find . -print0`
- `find . -maxdepth 1 -mindepth 1 -print0` for parsed ls
- `stat -f '%N<SOH>%z<SOH>%m<SOH>%HT<SOH>%Lp' words.txt 'space name.txt' nested link`
- `du -k -s .`
- `df -k -P .`
- `realpath words.txt`
- `which bun`
- `mktemp <capture-root>/created.XXXXXX`
- `tree -J --noreport .`

SOH is a literal byte 0x01. BSD stat rejects `%x00`; GNU `-c` interprets `%x`
as access time followed by literal `00`. Neither accepts a NUL in argv.
The parser reads numeric metadata after the name and supports names containing
newlines and SOH. The formats use a newline record terminator. stat-paths.darwin.txt is a second
real capture with newline and SOH bytes inside filenames.

stat.linux.txt and df.linux.txt are hand-written, not Linux captures. They follow
the GNU [stat format directives](https://www.gnu.org/software/coreutils/manual/html_node/stat-invocation.html)
and [df portable format](https://www.gnu.org/software/coreutils/manual/html_node/df-invocation.html).
The Linux stat preset is `-c '%n<SOH>%s<SOH>%Y<SOH>%F<SOH>%a'`.
It normalizes regular file, regular empty file, directory and symbolic link,
including the capitalized BSD labels. Other types become other.

Parsed ls uses find and returns immediate basenames, including hidden files.
It does not provide real ls sorting or formatting. `fs.ls.raw` runs ls.
Tree suppresses its report record and normalizes link nodes to file to keep the
requested directory/file shape. Du and df retain paths containing spaces;
line-based du output cannot represent filenames containing newlines reliably.
