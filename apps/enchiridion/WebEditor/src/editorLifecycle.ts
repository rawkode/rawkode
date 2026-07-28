export function createSerializedPageLoader<Request>(
  flush: () => Promise<void>,
  load: (request: Request) => Promise<void>,
): (request: Request) => Promise<void> {
  let tail = Promise.resolve()

  return request => {
    const operation = tail.then(async () => {
      await flush()
      await load(request)
    })
    tail = operation.catch(() => undefined)
    return operation
  }
}
