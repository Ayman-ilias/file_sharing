/** Folder picking needs webkitdirectory; iPhones and some Android browsers lack it. */
export function supportsFolderPick(): boolean {
  return 'webkitdirectory' in document.createElement('input')
}
