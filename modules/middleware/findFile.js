import path from 'path';

import addLeadingSlash from '../utils/addLeadingSlash';
import createPackageURL from '../utils/createPackageURL';
import createSearch from '../utils/createSearch';
import fetchNpmPackage from '../utils/fetchNpmPackage';
import getIntegrity from '../utils/getIntegrity';
import getContentType from '../utils/getContentType';

function indexRedirect(req, res, entry) {
  // Redirect to the index file so relative imports
  // resolve correctly.
  res
    .set({
      'Cache-Control': 'public, max-age=31536000', // 1 year
      'Cache-Tag': 'redirect, index-redirect'
    })
    .redirect(
      302,
      createPackageURL(
        req.packageName,
        req.packageVersion,
        addLeadingSlash(entry.name),
        createSearch(req.query)
      )
    );
}

function stripLeadingSegment(name) {
  return name.replace(/^[^/]+\/?/, '');
}

/**
 * Search the given tarball for entries that match the given name.
 * Follows node's resolution algorithm.
 * https://nodejs.org/api/modules.html#modules_all_together
 */
function searchEntries(tarballStream, entryName, wantsIndex) {
  return new Promise((resolve, reject) => {
    const jsEntryName = `${entryName}.js`;
    const jsonEntryName = `${entryName}.json`;
    const entries = {};

    let foundEntry;

    if (entryName === '') {
      foundEntry = entries[''] = { name: '', type: 'directory' };
    }

    tarballStream
      .on('error', reject)
      .on('entry', (header, stream, next) => {
        const entry = {
          // Most packages have header names that look like `package/index.js`
          // so we shorten that to just `index.js` here. A few packages use a
          // prefix other than `package/`. e.g. the firebase package uses the
          // `firebase_npm/` prefix. So we just strip the first dir name.
          name: stripLeadingSegment(header.name),
          type: header.type
        };

        // Skip non-files and files that don't match the entryName.
        if (entry.type !== 'file' || entry.name.indexOf(entryName) !== 0) {
          stream.resume();
          stream.on('end', next);
          return;
        }

        entries[entry.name] = entry;

        // Dynamically create "directory" entries for all directories
        // that are in this file's path. Some tarballs omit these entries
        // for some reason, so this is the "brute force" method.
        let dir = path.dirname(entry.name);
        while (dir !== '.') {
          entries[dir] = entries[dir] || { name: dir, type: 'directory' };
          dir = path.dirname(dir);
        }

        if (
          entry.name === entryName ||
          // Allow accessing e.g. `/index.js` or `/index.json`
          // using `/index` for compatibility with npm
          (!wantsIndex && entry.name === jsEntryName) ||
          (!wantsIndex && entry.name === jsonEntryName)
        ) {
          if (foundEntry) {
            if (
              foundEntry.name !== entryName &&
              (entry.name === entryName ||
                (entry.name === jsEntryName &&
                  foundEntry.name === jsonEntryName))
            ) {
              // This entry is higher priority than the one
              // we already found. Replace it.
              delete foundEntry.content;
              foundEntry = entry;
            }
          } else {
            foundEntry = entry;
          }
        }

        const chunks = [];

        stream
          .on('data', chunk => chunks.push(chunk))
          .on('end', () => {
            const content = Buffer.concat(chunks);

            // Set some extra properties for files that we will
            // need to serve them and for ?meta listings.
            entry.contentType = getContentType(entry.name);
            entry.integrity = getIntegrity(content);
            entry.lastModified = header.mtime.toUTCString();
            entry.size = content.length;

            // Set the content only for the foundEntry and
            // discard the buffer for all others.
            if (entry === foundEntry) {
              entry.content = content;
            }

            next();
          });
      })
      .on('finish', () => {
        resolve({
          entries,
          // If we didn't find a matching file entry,
          // try a directory entry with the same name.
          foundEntry: foundEntry || entries[entryName] || null
        });
      });
  });
}

const leadingSlash = /^\//;
const multipleSlash = /\/\/+/;
const trailingSlash = /\/$/;

/**
 * Fetch and search the archive to try and find the requested file.
 * Redirect to the "index" file if a directory was requested.
 */
export default function findFile(req, res, next) {
  fetchNpmPackage(req.packageConfig).then(tarballStream => {
    const wantsIndex = trailingSlash.test(req.filename);

    // The name of the file/directory we're looking for.
    const entryName = req.filename
      .replace(multipleSlash, '/')
      .replace(trailingSlash, '')
      .replace(leadingSlash, '');

    searchEntries(tarballStream, entryName, wantsIndex).then(
      ({ entries, foundEntry }) => {
        if (!foundEntry) {
          return res
            .status(404)
            .set({
              'Cache-Control': 'public, max-age=31536000', // 1 year
              'Cache-Tag': 'missing, missing-entry'
            })
            .type('text')
            .send(`Cannot find "${req.filename}" in ${req.packageSpec}`);
        }

        // If the foundEntry is a directory and there is no trailing slash
        // on the request path, we need to redirect to some "index" file
        // inside that directory. This is so our URLs work in a similar way
        // to require("lib") in node where it searches for `lib/index.js`
        // and `lib/index.json` when `lib` is a directory.
        if (foundEntry.type === 'directory' && !wantsIndex) {
          const indexEntry =
            entries[path.join(entryName, 'index.js')] ||
            entries[path.join(entryName, 'index.json')];

          if (indexEntry && indexEntry.type === 'file') {
            return indexRedirect(req, res, indexEntry);
          } else {
            return res
              .status(404)
              .set({
                'Cache-Control': 'public, max-age=31536000', // 1 year
                'Cache-Tag': 'missing, missing-index'
              })
              .type('text')
              .send(
                `Cannot find an index in "${req.filename}" in ${
                  req.packageSpec
                }`
              );
          }
        }

        req.entries = entries;
        req.entry = foundEntry;

        next();
      }
    );
  });
}
