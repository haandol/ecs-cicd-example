FROM hashicorp/http-echo:alpine

RUN apk --no-cache add curl

EXPOSE 8090

CMD ["-listen=:8090", "-text=v1"]
