# Slim headless LibreOffice + Poppler for pptx -> PDF -> PNG conversion.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/tmp/lo-home

RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      libreoffice-core \
      poppler-utils \
      fonts-liberation \
      fonts-dejavu \
      fonts-noto \
      fonts-noto-cjk \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY render.sh /usr/local/bin/render
RUN chmod +x /usr/local/bin/render

WORKDIR /work
ENTRYPOINT ["render"]
