/** A path template whose interpolated ids are encoded: path`/v1/pay/sessions/${id}`. */
export function path(strings: TemplateStringsArray, ...ids: string[]): string {
  return strings.reduce((out, chunk, i) => {
    if (i === 0) return chunk
    const id = ids[i - 1] ?? ''
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('An identifier is empty.')
    }
    return out + encodeURIComponent(id) + chunk
  }, '')
}
