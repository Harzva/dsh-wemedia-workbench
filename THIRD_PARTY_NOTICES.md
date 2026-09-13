# Third-party boundaries

The repository's MIT license applies to its own code, with the existing
copyright notices in [LICENSE](LICENSE). It does not relicense dependencies,
platform services, user content, papers, images, fonts or model weights.

- The existing `dsh-oil-creator contributors` copyright notice is retained in
  [LICENSE](LICENSE); its upstream source is the
  [dsh-oil-creator MIT license](https://github.com/oil-oil/dsh-oil-creator/blob/main/LICENSE).
- WeChat body-cleaning reuse retains its upstream MIT notice in
  [docs/third-party/wechat-collector-MIT.txt](docs/third-party/wechat-collector-MIT.txt).
- DSH, Cordis and JavaScript dependencies are resolved from the package manifest
  and lockfile and retain their own package licenses.
- The optional formula script uses separately installed Matplotlib; see its
  [license documentation](https://matplotlib.org/stable/project/license.html).
- The optional PDF crop script uses separately installed PyMuPDF. PyMuPDF and
  MuPDF are offered under AGPL or commercial terms, not this project's MIT
  license. Review the [upstream license and copyright documentation](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)
  for the environment and distribution you intend to use.
- MinerU outputs can be supplied as explicit crop coordinates or reviewed
  candidates. No MinerU runtime, model weights or license rights are bundled.
- Channel adapter contracts do not include the external bridge implementations,
  platform credentials or permission to collect or republish third-party work.

Use only content you are authorized to process and share. A source citation or
crop-provenance manifest is not a copyright license.
