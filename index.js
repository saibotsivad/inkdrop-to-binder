#!/usr/bin/env node

const { version } = require('./package.json')
const { promisify } = require('util')
const { join, resolve } = require('path')
const fs = require('fs')
const matter = require('gray-matter')
const mkdirp = require('mkdirp')
const sade = require('sade')

const readdir = promisify(fs.readdir)
const fileExists = promisify(fs.access)
const writeFile = promisify(fs.writeFile)

const sanitizeFile = filename => filename.replace('/', '-') // TODO: sanitize

const singleTagBlock = tag => `- name: ${tag.name}
  color: ${tag.color}
  count: ${tag.count}
  created: ${new Date(tag.createdAt).toISOString()}
  updated: ${new Date(tag.updatedAt).toISOString()}
  _id: ${tag._id}
  _rev: ${tag._rev}`

const condensedTagBlock = tag => `- name: ${tag.name}
  _id: ${tag._id}`

const tagBlocks = tags => tags.map(singleTagBlock).join('\n')

const indent = (depth, string) => string.split('\n').map(s => `${Array(depth).fill(' ').join('')}${s}`).join('\n')

const configYamlString = (config, tags) => `---
updated: ${new Date(config.updatedAt).toISOString()}
_type: config
_id: ${config._id}
_rev: ${config._rev}
tags:
${indent(2, tagBlocks(tags || []))}
---
`

const bookYamlString = book => `---
title: ${book.name}
created: ${new Date(book.createdAt).toISOString()}
updated: ${new Date(book.updatedAt).toISOString()}
_type: book
_id: ${book._id}
_rev: ${book._rev}
---
`

const noteYamlString = (note, tagNames, metadata) => matter.stringify('\n' + note.body, {
	title: note.title,
	created: new Date(note.createdAt).toISOString(),
	updated: new Date(note.updatedAt).toISOString(),
	status: note.status !== 'none'
		? note.status
		: '',
	doctype: note.doctype,
	visibility: note.share,
	tasks: note.numOfTasks
		? {
			count: note.numOfTasks,
			completed: note.numOfCheckedTasks
		}
		: '',
	tags: tagNames && tagNames.length
		? tagNames.join(', ')
		: '',
	_type: note.doctype,
	_bookId: note.bookId,
	_id: note._id,
	_rev: note._rev,
	...metadata
})

sade('inkdrop-to-binder', true)
	.version(version)
	.option('--input, -i', 'The path to the Inkdrop backup folder.')
	.option('--output, -o', 'The path to the folder for the converted files.')
	.option('--ignoreCompleted', 'Do not write out Notes that have a "Completed" status.')
	.option('--verbose, -v', 'Log more output for debugging purposes.')
	.example('--input=/path/to/backup --output=/path/to/output')
	.action(async ({ input, output, ignoreCompleted, verbose }) => {
		if (!input || !output) {
			console.log('Invalid options, must specify input and output paths. Try --help for more information.')
			process.exit(1)
		}
		input = resolve(input)
		output = resolve(output)

		const log = (level, message, ...args) => {
			if (level !== 'debug' || verbose) {
				const prefix = verbose
					? `[${new Date().toISOString()}] `
					: ''
				console[level](`${prefix}[${level.toUpperCase()}]`, message, ...args)
			}
		}

		log('debug', 'Using input folder:', input)
		log('debug', 'Using output folder:', output)

		try {
			const read = filename => require(join(input, 'data', filename))

			const filenames = await readdir(join(input, 'data'))

			const { book: books, note: notes, tag: tags } = filenames
				.reduce((map, filename) => {
					const [ type, idJson ] = filename.split(':')
					if (idJson) {
						map[type] = map[type] || {}
						map[type][`${type}:${idJson.replace('.json', '')}`] = read(filename)
					}
					return map
				}, {})

			log('info', 'Book count:', Object.keys(books).length)
			log('info', 'Note count:', Object.keys(notes).length)
			log('info', 'Tag count:', Object.keys(tags).length)

			const config = read('config.json')
			const configFilePath = join(output, '_README.md')
			log('debug', 'Writing config file:', configFilePath)
			await mkdirp(output)
			await writeFile(configFilePath, configYamlString(config, Object.values(tags)), { encoding: 'utf8' })

			const getOutputPath = (parentBookId, depth = []) => {
				if (!parentBookId || !books[parentBookId]) {
					return join(...depth.reverse().map(id => sanitizeFile(books[id].name)))
				} else {
					depth.push(parentBookId)
					return getOutputPath(books[parentBookId].parentBookId, depth)
				}
			}

			const bookIdToFolderPath = {}

			for (const bookId in books) {
				const book = books[bookId]
				const yaml = bookYamlString(book)

				const bookPath = join(getOutputPath(book.parentBookId), sanitizeFile(book.name))
				bookIdToFolderPath[bookId] = bookPath
				log('debug', 'Writing config for book:', bookPath)
				const fullFolderPath = join(output, bookPath)
				await mkdirp(fullFolderPath)
				await writeFile(join(fullFolderPath, '_README.md'), yaml, { encoding: 'utf8' })
			}

			const noteIsSkippable = note => note.bookId === 'trash'
				|| (note.status === 'completed' && ignoreCompleted)

			for (const noteId in notes) {
				const note = notes[noteId]
				if (noteIsSkippable(note)) {
					log('debug', 'Skipping note:', noteId)
				} else if (!bookIdToFolderPath[note.bookId]) {
					// This usually happens when a Book gets deleted
					// without first correctly migrating all Notes.
					log('debug', 'Found note without book:', noteId)
				} else {
					let noteMetadata = {}
					if (note.body.startsWith('---\n')) {
						try {
							const { data } = matter(note.body)
							noteMetadata = data
						} catch (error) {
							log('warn', 'Ignoring bad frontmatter for note:', noteId)
							if (error.name === 'YAMLException') {
								log('warn', 'Reason given:', error.reason, `(line ${error.mark.line + 1}, column ${error.mark.column + 1})`)
							}
						}
					}
					const filename = `${sanitizeFile(note.title)}${note.title.endsWith('.md') ? '' : '.md'}`
					const filePath = join(bookIdToFolderPath[note.bookId], filename)
					log('debug', 'Writing note:', filePath)
					const tagNames = (note.tags || [])
						.map(tagId => tags[tagId].name)
						.filter(Boolean)
					let fullFilePath = join(output, filePath)
					try {
						await fileExists(fullFilePath)
						if (filename === '_README.md') {
							// We can replace the automatically generated one, but
							// also merge the yaml properties?
						} else {
							log('warn', 'Detected a note with a duplicate title', `(${noteId})`, `"${note.title}"`)
							// Create a copy with a different name?
							// recommend setting a `canonical` property?
						}
					} catch {
						// ignore
					}
					await writeFile(fullFilePath, noteYamlString(note, tagNames, noteMetadata), { encoding: 'utf8' })
				}
			}
		} catch (error) {
			console.error(error)
		}
	})
	.parse(process.argv)
