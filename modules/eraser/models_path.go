package eraser

// ModelPath returns the installed model file of a preset ("best" = LaMa,
// "fast" = MI-GAN), for Paint+'s fill tools; false when it isn't downloaded.
func (m *Module) ModelPath(preset string) (string, bool) {
	spec, ok := models[Model(preset)]
	if !ok || !m.modelPresent(preset) {
		return "", false
	}
	return m.modelFile(spec), true
}
