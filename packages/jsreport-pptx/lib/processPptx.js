const { DOMParser, XMLSerializer } = require('@xmldom/xmldom')
const { decompress, saveXmlsToOfficeFile } = require('@jsreport/office')
const preprocess = require('./preprocess/preprocess.js')
const postprocess = require('./postprocess/postprocess.js')
const { contentIsXML } = require('./utils.js')

module.exports = (reporter) => async (inputs, req) => {
  const { pptxTemplateContent, outputPath } = inputs

  try {
    let files

    try {
      files = await decompress()(pptxTemplateContent)
    } catch (parseTemplateError) {
      throw reporter.createError('Failed to parse pptx template input', {
        original: parseTemplateError
      })
    }

    for (const f of files) {
      if (contentIsXML(f.data)) {
        f.doc = new DOMParser().parseFromString(f.data.toString())
        f.data = f.data.toString()
      }
    }

    await preprocess(files)

    const filesToRender = files.filter(f => contentIsXML(f.data))

    const contentToRender = (
      filesToRender
        .map(f => new XMLSerializer().serializeToString(f.doc).replace(/<pptxRemove>/g, '').replace(/<\/pptxRemove>/g, ''))
        .join('$$$pptxFile$$$')
    )

    reporter.logger.debug('Starting child request to render pptx dynamic parts', req)

    const { content: newContent } = await reporter.render({
      template: {
        content: contentToRender,
        engine: req.template.engine,
        recipe: 'html',
        helpers: req.template.helpers
      }
    }, req)

    // we remove NUL, VERTICAL TAB unicode characters, which are characters that is illegal in XML.
    // NOTE: we should likely find a way to remove illegal characters more generally, using some kind of unicode ranges
    // eslint-disable-next-line no-control-regex
    const contents = newContent.toString().replace(/\u0000|\u000b/g, '').split('$$$pptxFile$$$')

    for (let i = 0; i < filesToRender.length; i++) {
      filesToRender[i].data = contents[i]
      filesToRender[i].doc = new DOMParser().parseFromString(contents[i])
    }

    await postprocess(files)

    for (const f of files) {
      let isXML = false

      if (f.data == null) {
        isXML = f.path.includes('.xml')
      } else {
        isXML = contentIsXML(f.data)
      }

      if (isXML) {
        f.data = Buffer.from(new XMLSerializer().serializeToString(f.doc))
      }
    }

    await saveXmlsToOfficeFile({
      outputPath,
      files
    })

    reporter.logger.debug('pptx successfully zipped', req)

    return {
      pptxFilePath: outputPath
    }
  } catch (e) {
    throw reporter.createError('Error while executing pptx recipe', {
      original: e,
      weak: true
    })
  }
}