FROM python:3.11-slim
WORKDIR /app
COPY emit.py /app/emit.py
RUN chmod +x /app/emit.py
ENTRYPOINT ["python3", "/app/emit.py"]
