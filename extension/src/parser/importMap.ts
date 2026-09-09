/**
 * Import name → PyPI distribution name.
 *
 * Python's import name and its PyPI name are two different strings, and for a
 * meaningful number of very popular packages they disagree: you `import yaml`
 * but you `pip install PyYAML`. Checking the import name directly would report
 * some of the most widely used packages in the ecosystem as "not on PyPI" —
 * the exact false positive that makes a security tool get switched off.
 *
 * This is a lookup table rather than a resolver on purpose. Resolving it
 * properly means reading installed distribution metadata, which the extension
 * cannot do (it does not know which interpreter the file will run under) and
 * which would not help for a package that is not installed yet — the main case
 * Blueberry exists for.
 *
 * Anything absent from the table falls through unchanged, which is correct for
 * the overwhelming majority of packages.
 */

/** Import names whose PyPI distribution is spelled differently. */
export const IMPORT_TO_PYPI: ReadonlyMap<string, string> = new Map([
  ['yaml', 'PyYAML'],
  ['cv2', 'opencv-python'],
  ['sklearn', 'scikit-learn'],
  ['skimage', 'scikit-image'],
  ['PIL', 'Pillow'],
  ['bs4', 'beautifulsoup4'],
  ['dateutil', 'python-dateutil'],
  ['dotenv', 'python-dotenv'],
  ['jwt', 'PyJWT'],
  ['serial', 'pyserial'],
  ['usb', 'pyusb'],
  ['OpenSSL', 'pyOpenSSL'],
  ['Crypto', 'pycryptodome'],
  ['Cryptodome', 'pycryptodomex'],
  ['docx', 'python-docx'],
  ['pptx', 'python-pptx'],
  ['fitz', 'PyMuPDF'],
  ['magic', 'python-magic'],
  ['redis', 'redis'],
  ['psycopg2', 'psycopg2-binary'],
  ['MySQLdb', 'mysqlclient'],
  ['google', 'google-api-python-client'],
  ['grpc', 'grpcio'],
  ['attr', 'attrs'],
  ['pkg_resources', 'setuptools'],
  ['setuptools', 'setuptools'],
  ['win32api', 'pywin32'],
  ['win32com', 'pywin32'],
  ['win32con', 'pywin32'],
  ['pythoncom', 'pywin32'],
  ['zoneinfo_backport', 'backports.zoneinfo'],
  ['mpl_toolkits', 'matplotlib'],
  ['pylab', 'matplotlib'],
  ['IPython', 'ipython'],
  ['jinja2', 'Jinja2'],
  ['markdown', 'Markdown'],
  ['nacl', 'PyNaCl'],
  ['pyaudio', 'PyAudio'],
  ['gi', 'PyGObject'],
  ['wx', 'wxPython'],
  ['qtpy', 'QtPy'],
  ['PySide6', 'PySide6'],
  ['PyQt5', 'PyQt5'],
  ['PyQt6', 'PyQt6'],
  ['tensorflow', 'tensorflow'],
  ['torch', 'torch'],
  ['lxml', 'lxml'],
  ['ruamel', 'ruamel.yaml'],
  ['zmq', 'pyzmq'],
  ['slugify', 'python-slugify'],
  ['jose', 'python-jose'],
  ['multipart', 'python-multipart'],
  ['memcache', 'python-memcached'],
  ['ldap', 'python-ldap'],
  ['snappy', 'python-snappy'],
  ['telegram', 'python-telegram-bot'],
  ['git', 'GitPython'],
  ['github', 'PyGithub'],
  ['dns', 'dnspython'],
  ['Levenshtein', 'python-Levenshtein'],
  ['pkg_config', 'pkgconfig'],
  ['importlib_metadata', 'importlib-metadata'],
  ['typing_extensions', 'typing-extensions'],
  ['pydantic_settings', 'pydantic-settings'],
]);

/**
 * Map a Python import name to the PyPI distribution it comes from.
 *
 * Returns the input unchanged when there is no known difference.
 */
export function toDistributionName(importName: string): string {
  return IMPORT_TO_PYPI.get(importName) ?? importName;
}
