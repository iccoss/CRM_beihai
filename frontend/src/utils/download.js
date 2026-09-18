export function downloadBlobResponse(response, fallbackName) {
  const disposition = response.headers?.['content-disposition'] || ''
  const match = disposition.match(/filename="?([^";]+)"?/i)
  const filename = match?.[1] || fallbackName
  const blob = response.data instanceof Blob
    ? response.data
    : new Blob([response.data], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
