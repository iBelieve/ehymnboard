# Copied from https://github.com/nickjj/docker-flask-example/blob/92b39fe9058f2b9fa357ea4d06c063b0d04f2b3a/config/gunicorn.py
import multiprocessing
import os
from str2bool import str2bool

bind = f"0.0.0.0:{os.getenv('PORT', '8000')}"
accesslog = "-"
access_log_format = "%(h)s %(l)s %(u)s %(t)s '%(r)s' %(s)s %(b)s '%(f)s' '%(a)s' in %(D)sµs"  # noqa: E501

workers = int(os.getenv("WEB_CONCURRENCY", multiprocessing.cpu_count() * 2))
threads = int(os.getenv("PYTHON_MAX_THREADS", 1))

reload = bool(str2bool(os.getenv("WEB_RELOAD", "false")))

timeout = int(os.getenv("WEB_TIMEOUT", 120))
