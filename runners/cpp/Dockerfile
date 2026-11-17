FROM gcc:14-bookworm
RUN groupadd --gid 10001 runner && useradd --uid 10001 --gid 10001 --no-create-home runner
COPY run.sh /runner/run.sh
RUN chmod 0555 /runner/run.sh
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/timeout", "--signal=KILL", "15s", "/bin/sh", "/runner/run.sh"]
