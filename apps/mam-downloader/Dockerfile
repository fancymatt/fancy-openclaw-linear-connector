FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY src/ src/
COPY KNOWN_LIMITATIONS.md README.md ./

EXPOSE 8687

CMD ["python", "-m", "mam_downloader", "--serve"]
