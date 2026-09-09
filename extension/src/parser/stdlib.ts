/**
 * Python standard-library top-level module names.
 *
 * The single most important false-positive filter in the extension. Without
 * it, every `import os` in the workspace becomes a backend request that comes
 * back "not on PyPI" — which is true, and useless, and would bury the one
 * warning that mattered under a hundred that did not.
 *
 * Covers CPython 3.8–3.12 taken together rather than one version: a name that
 * was stdlib in 3.8 and removed in 3.12 (`distutils`, the `lib2to3` family)
 * still must not be reported as a hallucinated package, because it isn't one.
 */

/** Every top-level module importable from a stock CPython install. */
export const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set([
  '__future__', '__main__', '_thread', 'abc', 'aifc', 'argparse', 'array',
  'ast', 'asynchat', 'asyncio', 'asyncore', 'atexit', 'audioop', 'base64',
  'bdb', 'binascii', 'binhex', 'bisect', 'builtins', 'bz2', 'cProfile',
  'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs',
  'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser',
  'contextlib', 'contextvars', 'copy', 'copyreg', 'crypt', 'csv', 'ctypes',
  'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis',
  'distutils', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno',
  'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'formatter',
  'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext',
  'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'http', 'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math',
  'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt', 'multiprocessing',
  'netrc', 'nis', 'nntplib', 'ntpath', 'numbers', 'operator', 'optparse',
  'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes',
  'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint',
  'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc',
  'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource',
  'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve',
  'shlex', 'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket',
  'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string',
  'stringprep', 'struct', 'subprocess', 'sunau', 'symtable', 'sys',
  'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile',
  'termios', 'test', 'textwrap', 'threading', 'time', 'timeit', 'tkinter',
  'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty',
  'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest',
  'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser',
  'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp',
  'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

/**
 * Return true if `name` is a standard-library module and needs no check.
 */
export function isStandardLibrary(name: string): boolean {
  return PYTHON_STDLIB_MODULES.has(name);
}
