import { useMemo } from 'react';
import { Image, StyleSheet, View, useWindowDimensions } from 'react-native';

const backgroundTile = require('../assets/bg-tile.gif');
const backgroundWash = require('../assets/background-wash.png');
const backgroundBlueOrb = require('../assets/background-blue-orb.png');
const backgroundPinkOrb = require('../assets/background-pink-orb.png');

const TILE_WIDTH = 225;
const TILE_HEIGHT = 165;

type WebsiteBackdropProps = {
  darkMode?: boolean;
};

export function WebsiteBackdrop({ darkMode = false }: WebsiteBackdropProps) {
  const { width, height } = useWindowDimensions();
  const tiles = useMemo(() => {
    const columns = Math.ceil(width / TILE_WIDTH) + 1;
    const rows = Math.ceil(height / TILE_HEIGHT) + 1;
    const nextTiles = [];

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        nextTiles.push(
          <Image
            key={`${column}-${row}`}
            source={backgroundTile}
            style={[
              styles.tile,
              {
                left: column * TILE_WIDTH,
                top: row * TILE_HEIGHT,
              },
            ]}
          />,
        );
      }
    }

    return nextTiles;
  }, [height, width]);

  return (
    <View
      pointerEvents="none"
      style={[
        styles.root,
        darkMode ? styles.rootDark : styles.rootLight,
      ]}
    >
      <View style={[styles.tileLayer, darkMode && styles.tileLayerDark]}>{tiles}</View>
      <Image
        resizeMode="stretch"
        source={backgroundWash}
        style={[styles.wash, darkMode && styles.washDark]}
      />
      <Image
        resizeMode="stretch"
        source={backgroundBlueOrb}
        style={[styles.blueOrb, darkMode && styles.blueOrbDark]}
      />
      <Image
        resizeMode="stretch"
        source={backgroundPinkOrb}
        style={[styles.pinkOrb, darkMode && styles.pinkOrbDark]}
      />
      {darkMode ? (
        <>
          <View style={styles.darkVeil} />
          <View style={styles.darkCoolVeil} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
  },
  rootLight: {
    backgroundColor: '#f6f6f2',
  },
  rootDark: {
    backgroundColor: '#0b0f16',
  },
  tileLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  tileLayerDark: {
    opacity: 0.66,
  },
  tile: {
    position: 'absolute',
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
  },
  wash: {
    ...StyleSheet.absoluteFillObject,
  },
  washDark: {
    opacity: 0.52,
  },
  blueOrb: {
    position: 'absolute',
    top: '-8%',
    left: '-35%',
    width: '120%',
    height: '32%',
  },
  blueOrbDark: {
    opacity: 0.64,
  },
  pinkOrb: {
    position: 'absolute',
    top: '2%',
    right: '-38%',
    width: '108%',
    height: '28%',
  },
  pinkOrbDark: {
    opacity: 0.56,
  },
  darkVeil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5, 8, 14, 0.54)',
  },
  darkCoolVeil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(14, 24, 42, 0.16)',
  },
});
