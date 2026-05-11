FROM python:3.11-slim
WORKDIR /app
# msgpack is needed for the direct forward-protocol mode (the
# generator can speak Fluentd's wire format straight to the engine's
# unix socket, bypassing Fluent Bit). Stdlib otherwise sufficient.
RUN pip install --no-cache-dir msgpack==1.0.7
COPY emit.py /app/emit.py
RUN chmod +x /app/emit.py
ENTRYPOINT ["python3", "/app/emit.py"]
