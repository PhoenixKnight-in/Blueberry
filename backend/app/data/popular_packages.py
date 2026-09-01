"""Curated list of high-traffic PyPI package names.

This is the reference corpus the similarity engine measures against. It is a
static, in-process list on purpose: the typosquat check must be the cheapest
thing in the pipeline so it can run first, before any network call, and a
name that is one edit from ``requests`` is worth flagging whether or not PyPI
is reachable at that moment.

Selection criteria: packages with sustained high download volume, the names an
attacker would actually bother squatting, plus the ecosystems (AWS, ML, web)
where AI assistants most often invent imports. Names are stored in PEP 503
normalised form -- lowercase with ``-`` separators -- because that is the form
:func:`app.security.validation.canonicalize_package_name` produces, and
comparing anything else would make ``PyYAML`` look two edits from ``pyyaml``.

Tuning this list is a first-class way to tune detection: adding a name makes
its neighbourhood suspicious, and no checker code has to change.
"""

from __future__ import annotations

# fmt: off
_RAW_POPULAR_PACKAGES: tuple[str, ...] = (
    # --- Packaging / stdlib-adjacent core ---------------------------------
    "setuptools", "pip", "wheel", "packaging", "six", "typing-extensions",
    "attrs", "importlib-metadata", "importlib-resources", "zipp", "filelock",
    "platformdirs", "distlib", "virtualenv", "tomli", "tomlkit", "toml",
    "exceptiongroup", "pluggy", "iniconfig", "more-itertools", "wrapt",
    "decorator", "cached-property", "typing-inspect", "annotated-types",
    "build", "twine", "hatchling", "flit-core", "poetry", "poetry-core",
    "pdm", "pipenv", "setuptools-scm", "pkginfo", "readme-renderer",

    # --- HTTP / networking -------------------------------------------------
    "requests", "urllib3", "certifi", "idna", "charset-normalizer", "chardet",
    "httpx", "httpcore", "h11", "h2", "aiohttp", "aiosignal", "frozenlist",
    "multidict", "yarl", "async-timeout", "anyio", "sniffio", "websockets",
    "websocket-client", "requests-toolbelt", "requests-oauthlib", "oauthlib",
    "urllib3-secure-extra", "dnspython", "email-validator", "validators",
    "tldextract", "furl", "purl",

    # --- Cloud SDKs --------------------------------------------------------
    "boto3", "botocore", "s3transfer", "jmespath", "awscli", "aiobotocore",
    "azure-core", "azure-identity", "azure-storage-blob", "msal",
    "google-auth", "google-auth-oauthlib", "google-api-core",
    "google-api-python-client", "google-cloud-storage", "google-cloud-core",
    "googleapis-common-protos", "grpcio", "grpcio-status", "grpcio-tools",
    "protobuf", "proto-plus",

    # --- Crypto / auth -----------------------------------------------------
    "cryptography", "cffi", "pycparser", "pyopenssl", "pynacl", "bcrypt",
    "passlib", "argon2-cffi", "pyjwt", "python-jose", "rsa", "pyasn1",
    "pyasn1-modules", "paramiko", "keyring", "itsdangerous", "secretstorage",

    # --- Web frameworks / servers -----------------------------------------
    "django", "flask", "fastapi", "starlette", "pydantic", "pydantic-core",
    "pydantic-settings", "uvicorn", "gunicorn", "werkzeug", "jinja2",
    "markupsafe", "click", "blinker", "tornado", "bottle", "pyramid",
    "sanic", "falcon", "aiohttp-cors", "flask-cors", "flask-sqlalchemy",
    "flask-migrate", "flask-login", "djangorestframework", "django-cors-headers",
    "django-filter", "django-environ", "celery", "kombu", "amqp", "vine",
    "billiard", "flower", "gevent", "greenlet", "eventlet",

    # --- Databases ---------------------------------------------------------
    "sqlalchemy", "alembic", "psycopg2", "psycopg2-binary", "psycopg",
    "asyncpg", "pymysql", "mysqlclient", "aiomysql", "redis", "aioredis",
    "pymongo", "motor", "elasticsearch", "opensearch-py", "cassandra-driver",
    "peewee", "tortoise-orm", "databases", "sqlmodel", "duckdb", "aiosqlite",

    # --- Data / scientific -------------------------------------------------
    "numpy", "scipy", "pandas", "polars", "pyarrow", "matplotlib", "seaborn",
    "plotly", "bokeh", "altair", "dash", "statsmodels", "patsy", "sympy",
    "networkx", "numba", "llvmlite", "cython", "pybind11", "h5py", "netcdf4",
    "xarray", "dask", "distributed", "vaex", "modin", "openpyxl", "xlsxwriter",
    "xlrd", "et-xmlfile", "tabulate", "prettytable",

    # --- Machine learning --------------------------------------------------
    "scikit-learn", "joblib", "threadpoolctl", "torch", "torchvision",
    "torchaudio", "tensorflow", "keras", "jax", "jaxlib", "flax",
    "transformers", "tokenizers", "huggingface-hub", "safetensors", "datasets",
    "accelerate", "diffusers", "sentencepiece", "sentence-transformers",
    "xgboost", "lightgbm", "catboost", "nltk", "spacy", "gensim", "textblob",
    "opencv-python", "opencv-python-headless", "pillow", "imageio",
    "scikit-image", "albumentations", "onnx", "onnxruntime", "openai",
    "anthropic", "tiktoken", "langchain", "langchain-core", "llama-index",

    # --- Serialisation / config -------------------------------------------
    "pyyaml", "ruamel-yaml", "orjson", "ujson", "simplejson", "msgpack",
    "jsonschema", "jsonpatch", "jsonpointer", "python-dotenv", "environs",
    "marshmallow", "cerberus", "configobj", "dynaconf", "omegaconf",
    "dataclasses-json", "cattrs", "jsonpickle",

    # --- CLI / terminal ----------------------------------------------------
    "rich", "typer", "colorama", "termcolor", "tqdm", "prompt-toolkit",
    "wcwidth", "blessed", "questionary", "fire", "docopt", "argcomplete",
    "shellingham", "pygments", "humanize",

    # --- Testing / quality -------------------------------------------------
    "pytest", "pytest-cov", "pytest-asyncio", "pytest-mock", "pytest-xdist",
    "pytest-django", "coverage", "tox", "nox", "hypothesis", "faker",
    "factory-boy", "freezegun", "responses", "respx", "vcrpy", "mock",
    "black", "isort", "flake8", "pycodestyle", "pyflakes", "mccabe", "pylint",
    "astroid", "ruff", "mypy", "mypy-extensions", "bandit", "safety",
    "pre-commit", "cfgv", "identify", "nodeenv", "types-requests",

    # --- Docs --------------------------------------------------------------
    "sphinx", "docutils", "babel", "alabaster", "imagesize", "snowballstemmer",
    "mkdocs", "mkdocs-material", "markdown", "markdown-it-py", "mdurl",
    "mistune", "myst-parser",

    # --- Notebooks ---------------------------------------------------------
    "ipython", "ipykernel", "jupyter", "jupyterlab", "notebook",
    "jupyter-core", "jupyter-client", "nbformat", "nbconvert", "traitlets",
    "pyzmq", "jedi", "parso", "matplotlib-inline", "pexpect", "ptyprocess",
    "pickleshare", "backcall", "widgetsnbextension", "ipywidgets",

    # --- Scraping / parsing ------------------------------------------------
    "beautifulsoup4", "soupsieve", "lxml", "html5lib", "pyquery", "scrapy",
    "selenium", "playwright", "feedparser", "w3lib", "parsel", "cssselect",

    # --- Files / documents -------------------------------------------------
    "pypdf", "pypdf2", "pdfminer-six", "reportlab", "weasyprint", "qrcode",
    "python-docx", "python-pptx", "xmltodict", "defusedxml",

    # --- Dates / text ------------------------------------------------------
    "python-dateutil", "pytz", "tzdata", "tzlocal", "arrow", "pendulum",
    "croniter", "regex", "unidecode", "ftfy", "emoji", "rapidfuzz",
    "python-levenshtein", "jellyfish", "fuzzywuzzy", "phonenumbers",
    "text-unidecode", "slugify", "python-slugify", "inflection",

    # --- Ops / observability ------------------------------------------------
    "psutil", "docker", "kubernetes", "ansible", "fabric", "invoke",
    "watchdog", "schedule", "apscheduler", "supervisor", "sentry-sdk",
    "structlog", "loguru", "python-json-logger", "prometheus-client",
    "opentelemetry-api", "opentelemetry-sdk", "statsd", "datadog", "newrelic",

    # --- Messaging / streaming ---------------------------------------------
    "pika", "kafka-python", "confluent-kafka", "paho-mqtt", "pyserial",

    # --- Resilience / utility ----------------------------------------------
    "tenacity", "backoff", "retrying", "cachetools", "diskcache", "toolz",
    "boltons", "funcy", "shortuuid", "uuid-utils", "chevron", "deepdiff",
    "sortedcontainers", "bitarray", "pycryptodome", "pycryptodomex",
)
# fmt: on

#: The corpus, de-duplicated and frozen. A ``frozenset`` for O(1) exact-match
#: lookups; the tuple preserves a stable order for deterministic tie-breaking
#: when two popular names sit at the same edit distance.
POPULAR_PACKAGES: tuple[str, ...] = tuple(dict.fromkeys(_RAW_POPULAR_PACKAGES))

POPULAR_PACKAGE_SET: frozenset[str] = frozenset(POPULAR_PACKAGES)

__all__ = ["POPULAR_PACKAGES", "POPULAR_PACKAGE_SET"]
