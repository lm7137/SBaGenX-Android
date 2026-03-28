import { useMemo } from 'react';
import { Image, StyleSheet, View, useWindowDimensions } from 'react-native';

const backgroundTile = require('../assets/bg-tile.gif');
const backgroundWash = require('../assets/background-wash.png');
const backgroundBlueOrb = require('../assets/background-blue-orb.png');
const backgroundPinkOrb = require('../assets/background-pink-orb.png');

const TILE_WIDTH = 225;
const TILE_HEIGHT = 165;

export function WebsiteBackdrop() {
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
    <View pointerEvents="none" style={styles.root}>
      <View style={styles.tileLayer}>{tiles}</View>
      <Image resizeMode="stretch" source={backgroundWash} style={styles.wash} />
      <Image resizeMode="stretch" source={backgroundBlueOrb} style={styles.blueOrb} />
      <Image resizeMode="stretch" source={backgroundPinkOrb} style={styles.pinkOrb} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#f6f6f2',
  },
  tileLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  tile: {
    position: 'absolute',
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
  },
  wash: {
    ...StyleSheet.absoluteFillObject,
  },
  blueOrb: {
    position: 'absolute',
    top: '-8%',
    left: '-35%',
    width: '120%',
    height: '32%',
  },
  pinkOrb: {
    position: 'absolute',
    top: '2%',
    right: '-38%',
    width: '108%',
    height: '28%',
  },
});
