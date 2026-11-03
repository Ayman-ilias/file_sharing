import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ayman, fakeApi, globalMe, json } from '../../test/http'
import { memoryStorage } from '../uploads/fakeServer'
import { Uploader } from '../uploads/Uploader'
import { SendCard } from './SendCard'

const users = [
  { id: 5, username: 'rahim', email: 'rahim@southerniot.net' },
  { id: 6, username: 'tanvir', email: 'tanvir@southerniot.net' },
  { id: 7, username: 'tasnim', email: 'tasnim@southerniot.net' },
]

function engine() {
  const api = { get: vi.fn(), send: vi.fn(), put: vi.fn() }
  return new Uploader({ api, env: new EventTarget(), storage: memoryStorage(), online: () => true })
}

afterEach(() => vi.restoreAllMocks())

const toBox = () => screen.getByLabelText('Add recipient')
const sendBtn = () => screen.getByRole('button', { name: 'Send' })
const chips = () => Array.from(document.querySelectorAll('.to .chip')).map((c) => c.textContent)

async function pick(name: string) {
  await userEvent.click(toBox())
  await userEvent.type(toBox(), name.slice(0, 2))
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }))
}

describe('SendCard: Send to', () => {
  it('lists Global first, then matching colleagues', async () => {
    fakeApi({ 'GET /api/users': () => json(200, users) })
    render(<SendCard me={ayman} uploader={engine()} />)
    await userEvent.click(toBox())
    await userEvent.type(toBox(), 'ta')
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Globaleveryone', 'TAtanvirtanvir@southerniot.net', 'TAtasnimtasnim@southerniot.net',
    ])
  })

  it('says when no colleague matches', async () => {
    fakeApi({ 'GET /api/users': () => json(200, users) })
    render(<SendCard me={ayman} uploader={engine()} />)
    await userEvent.type(toBox(), 'karim')
    expect(await screen.findByText('No colleague called "karim". Only people who have registered appear here.')).toBeInTheDocument()
  })

  it('picking Global removes the person chips', async () => {
    fakeApi({ 'GET /api/users': () => json(200, users) })
    render(<SendCard me={ayman} uploader={engine()} />)
    await pick('rahim')
    await pick('tanvir')
    expect(chips()).toEqual(['rahim', 'tanvir'])
    await userEvent.click(toBox())
    await userEvent.click(screen.getByRole('option', { name: /Global/ }))
    expect(chips()).toEqual(['Global (everyone)'])
    expect(screen.getByText('Everyone at Southern IoT can see this, and it goes to the Global section.')).toBeInTheDocument()
  })

  it('removes a chip with its button and with Backspace', async () => {
    fakeApi({ 'GET /api/users': () => json(200, users) })
    render(<SendCard me={ayman} uploader={engine()} />)
    await pick('rahim')
    await pick('tanvir')
    await userEvent.click(screen.getByRole('button', { name: 'Remove rahim' }))
    expect(chips()).toEqual(['tanvir'])
    await userEvent.click(toBox())
    await userEvent.keyboard('{Backspace}')
    expect(chips()).toEqual([])
  })

  it('the global account has a fixed Global chip it cannot remove', async () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    render(<SendCard me={globalMe} uploader={engine()} />)
    expect(chips()).toEqual(['Global (everyone)'])
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(screen.queryByLabelText('Add recipient')).toBeNull()
    expect(screen.getByText('The shared global account can only share with everyone.')).toBeInTheDocument()
  })
})

describe('SendCard: text', () => {
  it('Send stays disabled with no recipients', async () => {
    fakeApi({ 'GET /api/users': () => json(200, users) })
    render(<SendCard me={ayman} uploader={engine()} />)
    await userEvent.type(screen.getByLabelText('Text'), 'hello')
    expect(sendBtn()).toBeDisabled()
    await pick('rahim')
    expect(sendBtn()).toBeEnabled()
  })

  it('posts {title?, body, recipient_ids, is_global} and clears the form', async () => {
    const posted: unknown[] = []
    fakeApi({
      'GET /api/users': () => json(200, users),
      'POST /api/items/text': (init) => { posted.push(JSON.parse(String(init?.body))); return json(201, { id: 'x' }) },
    })
    render(<SendCard me={ayman} uploader={engine()} />)
    await pick('rahim')
    await userEvent.type(screen.getByLabelText('Text'), 'see https://x.io')
    await userEvent.click(sendBtn())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ body: 'see https://x.io', recipient_ids: [5], is_global: false })
    await waitFor(() => expect(screen.getByLabelText('Text')).toHaveValue(''))

    await userEvent.type(screen.getByLabelText(/Title/), 'Config')
    await userEvent.type(screen.getByLabelText('Text'), 'b')
    await userEvent.click(sendBtn())
    await waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[1]).toEqual({ title: 'Config', body: 'b', recipient_ids: [5], is_global: false })
    expect(chips()).toEqual(['rahim']) // recipients stay for the next send
  })

  it('counts characters', async () => {
    fakeApi({ 'GET /api/users': () => json(200, users) })
    render(<SendCard me={ayman} uploader={engine()} />)
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'x'.repeat(1234) } })
    expect(screen.getByText('1,234 characters')).toBeInTheDocument()
  })

  it('a text over 1 MiB shows the error and does not post', async () => {
    const f = fakeApi({ 'GET /api/users': () => json(200, users) })
    render(<SendCard me={globalMe} uploader={engine()} />)
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'é'.repeat(524_288) + 'x' } }) // 1 MiB + 1 byte
    expect(screen.getByText('Too long — send it as a file')).toBeInTheDocument()
    expect(sendBtn()).toBeDisabled()
    await userEvent.click(sendBtn())
    expect(f.mock.calls.filter(([u]) => String(u).includes('/api/items/text'))).toHaveLength(0)
  })
})

describe('SendCard: files and folders', () => {
  it('stages picked files and hands them to the engine with the target on Send', async () => {
    fakeApi({ 'GET /api/users': () => json(200, users) })
    const up = engine()
    const add = vi.spyOn(up, 'addFiles').mockResolvedValue({ duplicates: [] })
    render(<SendCard me={ayman} uploader={up} />)
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    const a = new File(['abc'], 'a.txt')
    await userEvent.upload(screen.getByLabelText('Choose files'), [a])
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(sendBtn()).toBeDisabled()
    await pick('tanvir')
    await userEvent.click(sendBtn())
    expect(add).toHaveBeenCalledWith([a], { recipientIds: [6], isGlobal: false })
    expect(screen.queryByText('Ready to send')).toBeNull()
  })

  it('says which files are already sending', async () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    const up = engine()
    vi.spyOn(up, 'addFiles').mockResolvedValue({ duplicates: ['a.txt'] })
    render(<SendCard me={globalMe} uploader={up} />)
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    await userEvent.upload(screen.getByLabelText('Choose files'), [new File(['a'], 'a.txt')])
    await userEvent.click(sendBtn())
    expect(await screen.findByText('Already sending: a.txt')).toBeInTheDocument()
  })

  it('sends a picked folder as one folder', async () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    const up = engine()
    const add = vi.spyOn(up, 'addFolder').mockImplementation(() => {})
    render(<SendCard me={globalMe} uploader={up} folderPick />)
    await userEvent.click(screen.getByRole('button', { name: 'Folder' }))
    const f = new File(['x'], 'a.txt')
    Object.defineProperty(f, 'webkitRelativePath', { value: 'site/a.txt' })
    await userEvent.upload(screen.getByLabelText('Choose a folder'), [f])
    expect(screen.getByText('site')).toBeInTheDocument()
    await userEvent.click(sendBtn())
    expect(add).toHaveBeenCalledWith([f], { recipientIds: [], isGlobal: true })
  })

  it('explains when the phone cannot choose folders', async () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    render(<SendCard me={globalMe} uploader={engine()} folderPick={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'Folder' }))
    expect(screen.getByText("This phone can't choose folders. Zip the folder, or use Files to pick several files.")).toBeInTheDocument()
    expect(screen.queryByLabelText('Choose a folder')).toBeNull()
  })

  it('shows the queue rows of the engine', async () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    const up = engine()
    vi.spyOn(up, 'jobs').mockReturnValue([
      { id: 'j1', kind: 'file', name: 'big.mp4', size: 100, sent: 50, state: 'sending', canRetry: false, speed: 0, eta: null, vault: false },
    ])
    render(<SendCard me={globalMe} uploader={up} />)
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(within(document.querySelector('.queue')!).getByText('big.mp4')).toBeInTheDocument()
  })

  it('shows the upload rows on the Text tab too (e.g. "Interrupted" after a reload)', () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    const up = engine()
    vi.spyOn(up, 'jobs').mockReturnValue([
      { id: 'j1', kind: 'file', name: 'report.pdf', size: 100, sent: 0, state: 'failed', reason: 'interrupted', canRetry: false, speed: 0, eta: null, vault: false },
    ])
    render(<SendCard me={globalMe} uploader={up} />)
    expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
  })

  it('says when a folder has more than 5,000 files, and does not send it', async () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    const up = engine()
    const add = vi.spyOn(up, 'addFolder').mockImplementation(() => {})
    render(<SendCard me={globalMe} uploader={up} folderPick />)
    await userEvent.click(screen.getByRole('button', { name: 'Folder' }))
    const files = Array.from({ length: 5001 }, (_, i) => {
      const f = new File(['x'], `f${i}.txt`)
      Object.defineProperty(f, 'webkitRelativePath', { value: `big/f${i}.txt` })
      return f
    })
    fireEvent.change(screen.getByLabelText('Choose a folder'), { target: { files } })
    expect(screen.getByText('This folder has 5,001 files. The limit is 5,000 — zip it, or send it in parts.')).toBeInTheDocument()
    expect(sendBtn()).toBeDisabled()
    expect(add).not.toHaveBeenCalled()
  })

  it('never shows My storage uploads in the Sharing queue', async () => {
    fakeApi({ 'GET /api/users': () => json(200, []) })
    const up = engine()
    vi.spyOn(up, 'jobs').mockReturnValue([
      { id: 'v1', kind: 'file', name: 'secret.pdf', size: 1, sent: 0, state: 'sending', canRetry: false, speed: 0, eta: null, vault: true },
    ])
    render(<SendCard me={globalMe} uploader={up} />)
    expect(screen.queryByText('secret.pdf')).toBeNull()
  })
})

