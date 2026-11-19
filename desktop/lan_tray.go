package desktop

import "fmt"

// lanTrayItems are the Local File Transfer rows of the tray menu: the status
// and "Stop receiving" while listening, "Start receiving files" when receiving
// is off but was meant to be on.
func lanTrayItems(s trayState) []trayItem {
	switch {
	case s.LanListening:
		return []trayItem{
			{ID: itemLanStatus, Label: "Receiving files — " + s.LanAlias},
			item(itemLanStop, "Stop receiving"),
		}
	case s.LanCanStart:
		return []trayItem{item(itemLanStart, "Start receiving files")}
	}
	return nil
}

// trayTooltip is the tray icon's tooltip.
func trayTooltip(s trayState) string {
	if s.WorkspaceName != "" {
		return trayTooltipBase(s) + " · " + s.WorkspaceName
	}
	return trayTooltipBase(s)
}

func trayTooltipBase(s trayState) string {
	switch {
	case s.LanPrompt != "":
		return fmt.Sprintf("Toolbox — %s wants to send you files", s.LanPrompt)
	case s.LanListening:
		return "Toolbox — receiving files as " + s.LanAlias
	}
	return "Toolbox"
}
