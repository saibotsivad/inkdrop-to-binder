# inkdrop-to-binder

Given an Inkdrop backup folder, convert it to a Blockdown Binder folder.

## Install

You must have [Node.js](https://nodejs.org/en/) version 12 or higher.

Then, install globally using:

```bash
npm install -g inkdrop-to-binder
```

## Use

Configure your Inkdrop application to make a backup to a folder, for example to `/home/me/inkdrop-backup`, then run the command:

```bash
inkdrop-to-binder \
  --input /home/me/inkdrop-backup \
  --output /home/me/inkdrop-binder
```

Note that if you delete a file from Inkdrop, a delete command won't be run to remove files from your Blockdown Binder. However, since the content is programmatically generated you can do:

```bash
rm -rf /home/me/inkdrop-binder \
  && inkdrop-to-binder \
    --input /home/me/inkdrop-backup \
    --output /home/me/inkdrop-binder
```

## License

Published and released under the [VOL](http://veryopenlicense.com).
