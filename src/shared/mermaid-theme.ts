export type MermaidTheme = 'dark' | 'light';

type ColorChannels = [number, number, number, number];

function colorChannels(color: string): ColorChannels | null {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim());
  if (hex) {
    const channels = hex[1].length === 3
      ? [...hex[1]].map(channel => parseInt(channel + channel, 16))
      : hex[1].match(/.{2}/g)!.map(channel => parseInt(channel, 16));
    return [channels[0], channels[1], channels[2], 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(color.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])] : null;
}

function luminance(color: string, underlay?: string): number | null {
  const channels = colorChannels(color);
  if (!channels) return null;
  let [red, green, blue] = channels;
  if (channels[3] < 1) {
    const underlayChannels = underlay ? colorChannels(underlay) : null;
    if (!underlayChannels || underlayChannels[3] < 1) return null;
    red = red * channels[3] + underlayChannels[0] * (1 - channels[3]);
    green = green * channels[3] + underlayChannels[1] * (1 - channels[3]);
    blue = blue * channels[3] + underlayChannels[2] * (1 - channels[3]);
  }
  const linear = [red, green, blue].map(channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

function contrast(foreground: string, background: string, underlay?: string): number | null {
  const foregroundLuminance = luminance(foreground, underlay);
  const backgroundLuminance = luminance(background, underlay);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  return (Math.max(foregroundLuminance, backgroundLuminance) + .05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
}

/** Return an accessible label color only when the theme's current label color fails on a rendered fill. */
export function mermaidLabelColorForContrast(currentColor: string, backgroundColor: string, underlayColor?: string): string | null {
  const currentContrast = contrast(currentColor, backgroundColor, underlayColor);
  if (currentContrast === null || currentContrast >= 4.5) return null;
  const blackContrast = contrast('#000000', backgroundColor, underlayColor);
  const whiteContrast = contrast('#ffffff', backgroundColor, underlayColor);
  if (blackContrast === null || whiteContrast === null) return null;
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}

export function mermaidThemeVariables(theme: MermaidTheme) {
  return theme === 'dark' ? {
    background: '#141311',
    primaryColor: '#2a394b',
    primaryTextColor: '#f5f7fb',
    primaryBorderColor: '#7894b3',
    secondaryColor: '#3b3025',
    secondaryTextColor: '#fff7ed',
    secondaryBorderColor: '#b58a61',
    tertiaryColor: '#26392f',
    tertiaryTextColor: '#effbf2',
    tertiaryBorderColor: '#76a889',
    lineColor: '#c5ccd5',
    textColor: '#f3f4f6',
    mainBkg: '#181715',
    nodeBorder: '#7894b3',
    clusterBkg: '#201e1b',
    clusterBorder: '#93816d',
    titleColor: '#f3f4f6',
    edgeLabelBackground: '#22201d',
    labelTextColor: '#f3f4f6',
    nodeTextColor: '#f3f4f6',
    actorBkg: '#2a394b',
    actorBorder: '#7894b3',
    actorTextColor: '#f5f7fb',
    actorLineColor: '#c5ccd5',
    signalColor: '#f3f4f6',
    signalTextColor: '#f3f4f6',
    noteBkgColor: '#3b3025',
    noteTextColor: '#fff7ed',
    sectionBkgColor: '#26392f',
    sectionBkgColor2: '#3b3025',
    altSectionBkgColor: '#2a394b',
    gridColor: '#55504a',
    taskBkgColor: '#2a394b',
    taskTextColor: '#f5f7fb',
    taskTextOutsideColor: '#f3f4f6',
    taskBorderColor: '#7894b3',
    cScale0: '#2a394b',
    cScale1: '#3b3025',
    cScale2: '#26392f',
  } : {
    background: '#ffffff',
    primaryColor: '#e8f1fb',
    primaryTextColor: '#172b40',
    primaryBorderColor: '#48698d',
    secondaryColor: '#f7eee1',
    secondaryTextColor: '#3c2b1a',
    secondaryBorderColor: '#8b6846',
    tertiaryColor: '#e9f4ec',
    tertiaryTextColor: '#1f3a29',
    tertiaryBorderColor: '#4f795c',
    lineColor: '#536273',
    textColor: '#1d2733',
    mainBkg: '#ffffff',
    nodeBorder: '#48698d',
    clusterBkg: '#f4f6f8',
    clusterBorder: '#68788a',
    titleColor: '#1d2733',
    edgeLabelBackground: '#ffffff',
    labelTextColor: '#1d2733',
    nodeTextColor: '#1d2733',
    actorBkg: '#e8f1fb',
    actorBorder: '#48698d',
    actorTextColor: '#172b40',
    actorLineColor: '#536273',
    signalColor: '#1d2733',
    signalTextColor: '#1d2733',
    noteBkgColor: '#f7eee1',
    noteTextColor: '#3c2b1a',
    sectionBkgColor: '#e9f4ec',
    sectionBkgColor2: '#f7eee1',
    altSectionBkgColor: '#e8f1fb',
    gridColor: '#c9d0d8',
    taskBkgColor: '#e8f1fb',
    taskTextColor: '#172b40',
    taskTextOutsideColor: '#1d2733',
    taskBorderColor: '#48698d',
    cScale0: '#e8f1fb',
    cScale1: '#f7eee1',
    cScale2: '#e9f4ec',
  };
}
