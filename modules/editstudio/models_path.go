package editstudio

// ModelPath returns the installed checkpoint of a matte preset ("people" |
// "select"), for Paint+'s Select object; false when it isn't downloaded.
func (m *Module) ModelPath(preset string) (string, bool) {
	if !m.ModelPresent(preset) {
		return "", false
	}
	return m.matteModelPath(preset), true
}
